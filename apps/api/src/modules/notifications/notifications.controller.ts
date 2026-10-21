import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { hasPermission, type NotificationPrefsDto, type PruebaPushDto, type RegistroPushDto } from '@ptap/shared';
import type { AuthenticatedRequest } from '../auth/authenticated-request';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../auth/guards/permission.guard';
import { RequirePermission } from '../auth/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../../infrastructure/validation/zod-validation.pipe';
import { NotificationRepository, type NotificationScope, type StoredNotification } from './notification.repository';
import { NotificationPrefsRepository } from './notification-prefs.repository';
import { notificationPrefsSchema } from './notification-prefs.dto';
import { DevicePushTokenRepository } from './device-push-token.repository';
import {
  quitarDispositivoSchema,
  registrarDispositivoSchema,
  type QuitarDispositivoDto,
  type RegistrarDispositivoDto,
} from './device-push-token.dto';
import { PushDispatcher } from './push.dispatcher';

/** Ventana del historial. El requisito es "mínimo 24 h"; se sirven 72 para cubrir un fin de semana. */
const HISTORY_HOURS = 72;
const MAX_ITEMS = 200;

/**
 * Bandeja de notificaciones.
 *
 * **No hay endpoint de borrado, y es deliberado.** El usuario no puede eliminar un aviso: solo
 * marcarlo como visto. El historial es evidencia operativa — si alguien pudiera borrar el aviso de
 * que un sensor lleva 15 días caído, se perdería justo el rastro que hace falta para reclamarlo.
 *
 * Exige `view_dashboard`: el Civil no recibe avisos de proceso (coherente con el resto de la
 * matriz, que no le da señales detalladas).
 *
 * **Acotada POR PLANTA.** Aquí no sirve `PlantScopeGuard`: estas rutas no llevan `:plantId`, así
 * que el guard es un no-op y el ámbito hay que aplicarlo en la consulta. Sin eso, un operador de
 * Km 18 recibía —y le sonaban en el celular— los avisos de las otras once plantas.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class NotificationsController {
  constructor(
    @Inject(NotificationRepository) private readonly repo: NotificationRepository,
    @Inject(NotificationPrefsRepository) private readonly prefs: NotificationPrefsRepository,
    @Inject(DevicePushTokenRepository) private readonly devices: DevicePushTokenRepository,
    @Inject(PushDispatcher) private readonly push: PushDispatcher,
  ) {}

  /**
   * Identidad y ámbito de quien pregunta.
   *
   * El estado de lectura es POR usuario, así que sin identidad no hay respuesta posible.
   * `JwtAuthGuard` ya lo garantiza; esto es la red de seguridad para que el tipo opcional no
   * degenere en un `!` que oculte un fallo de wiring de guards.
   *
   * `plantScope: null` significa TODAS las plantas y solo lo concede `view_all_plants` (hoy el
   * Admin). Para el resto es la planta de la cuenta — y si esa cuenta no trae planta, esto
   * FALLA en vez de caer a `null`: un fallo de wiring debe cerrar la bandeja, no abrirla entera.
   */
  private scopeOf(req: AuthenticatedRequest): { userId: string; plantScope: string | null } {
    const user = req.user;
    if (!user?.id) throw new UnauthorizedException('Sesión requerida');
    if (hasPermission(user.role, 'view_all_plants')) return { userId: user.id, plantScope: null };
    if (!user.plant) throw new ForbiddenException('Tu cuenta no tiene una planta asignada');
    return { userId: user.id, plantScope: user.plant };
  }

  /** Historial reciente de SU planta, con el estado de visto DE QUIEN pregunta. */
  @Get()
  @RequirePermission('view_dashboard')
  async list(@Req() req: AuthenticatedRequest): Promise<{ notifications: StoredNotification[]; unseen: number }> {
    const { userId, plantScope } = this.scopeOf(req);
    const scope: NotificationScope = { plantScope };
    const [notifications, unseen] = await Promise.all([
      this.repo.listRecent(userId, scope, HISTORY_HOURS, MAX_ITEMS),
      this.repo.countUnseen(userId, scope, HISTORY_HOURS),
    ]);
    return { notifications, unseen };
  }

  /** Solo el contador: es lo que sondea la campana, y así no se baja el historial entero. */
  @Get('unseen-count')
  @RequirePermission('view_dashboard')
  async unseenCount(@Req() req: AuthenticatedRequest): Promise<{ unseen: number }> {
    const { userId, plantScope } = this.scopeOf(req);
    return { unseen: await this.repo.countUnseen(userId, { plantScope }, HISTORY_HOURS) };
  }

  /**
   * Marca como vistos todos los avisos del historial. Lo llama el front al ABRIR la bandeja:
   * "visto" significa que la persona entró a mirarlos, que es exactamente lo que se pidió.
   */
  @Post('seen')
  @RequirePermission('view_dashboard')
  async markSeen(@Req() req: AuthenticatedRequest): Promise<{ marked: number }> {
    const { userId, plantScope } = this.scopeOf(req);
    return { marked: await this.repo.markAllSeen(userId, { plantScope }, HISTORY_HOURS) };
  }

  /** Qué avisos quiere recibir. Sin nada guardado devuelve el default: todo. */
  @Get('preferences')
  @RequirePermission('view_dashboard')
  async getPreferences(@Req() req: AuthenticatedRequest): Promise<NotificationPrefsDto> {
    const { userId } = this.scopeOf(req);
    return this.prefs.get(userId);
  }

  /**
   * Guarda las preferencias de QUIEN pide, y solo de quien pide: el `userId` sale del token, nunca
   * del cuerpo. Nadie puede callarle los avisos a otra persona.
   */
  @Put('preferences')
  @RequirePermission('view_dashboard')
  async putPreferences(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(notificationPrefsSchema)) body: NotificationPrefsDto,
  ): Promise<NotificationPrefsDto> {
    const { userId } = this.scopeOf(req);
    await this.prefs.save(userId, body);
    return body;
  }

  /**
   * Registra ESTE teléfono para recibir los avisos por push, a nombre de quien pide (el `userId` sale
   * del token, nunca del cuerpo). La app lo llama cada vez que se abre con el permiso concedido.
   *
   * `pushActivo` dice si el servidor puede empujar ahora mismo. La app solo deja de publicar por su
   * cuenta cuando es `true`: con el push apagado en el servidor, un teléfono que se creyera atendido
   * por push se quedaría sin ningún aviso.
   */
  @Post('devices')
  @RequirePermission('view_dashboard')
  async registerDevice(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(registrarDispositivoSchema)) body: RegistrarDispositivoDto,
  ): Promise<RegistroPushDto> {
    const { userId } = this.scopeOf(req);
    await this.devices.registrar(userId, body.token, body.platform, body.appVersion ?? null);
    return { registrado: true, pushActivo: this.push.active };
  }

  /**
   * Da de baja ESTE teléfono (al cerrar sesión). Solo si el token es de quien pide: nadie puede dejar
   * sin avisos el teléfono de otra persona aunque conozca su token.
   */
  @Post('devices/unregister')
  @RequirePermission('view_dashboard')
  async unregisterDevice(
    @Req() req: AuthenticatedRequest,
    @Body(new ZodValidationPipe(quitarDispositivoSchema)) body: QuitarDispositivoDto,
  ): Promise<{ quitado: boolean }> {
    const { userId } = this.scopeOf(req);
    return { quitado: (await this.devices.quitar(body.token, userId)) > 0 };
  }

  /**
   * Manda un aviso de prueba a los teléfonos de QUIEN LO PIDE, y a ninguno más. Sirve para comprobar
   * banner, sonido y pantalla de bloqueo sin esperar a una alarma real.
   */
  @Post('devices/prueba')
  @RequirePermission('view_dashboard')
  async testPush(@Req() req: AuthenticatedRequest): Promise<PruebaPushDto> {
    const { userId, plantScope } = this.scopeOf(req);
    return this.push.sendTest(userId, plantScope ?? req.user?.plant ?? '');
  }
}
