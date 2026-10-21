-- Teléfonos que reciben los avisos al instante, por push (Firebase Cloud Messaging).
--
-- POR QUÉ EXISTE. Hasta ahora el teléfono PREGUNTABA por avisos nuevos cada 15 minutos o más
-- (WorkManager), Android retrasaba esa consulta con la pantalla apagada y la sesión dura 8 horas: un
-- tanque rebosando podía tardar media hora en sonar, o no sonar nunca si la sesión había caducado.
-- WhatsApp suena en el momento porque su servidor EMPUJA el mensaje. Esta tabla es lo que permite
-- hacer lo mismo: el backend sabe a qué teléfonos mandar cada aviso en cuanto el detector lo guarda.
--
-- ES CONFIGURACIÓN, NO TELEMETRÍA (regla 1). Una fila por teléfono: su token de FCM y a nombre de
-- quién está. La consulta periódica sigue existiendo como respaldo para los teléfonos sin push.
--
-- EL TOKEN ES ÚNICO, no el par (usuario, token). Si en el mismo teléfono entra otra persona, el token
-- PASA a esa persona (ON DUPLICATE KEY UPDATE en el repositorio): un teléfono recibe los avisos de
-- quien tiene la sesión, nunca los de dos cuentas a la vez.
--
-- A QUIÉN SE MANDA NO SE GUARDA AQUÍ. Rol, planta y cuenta activa se leen de `users` en el momento
-- de cada envío, con la misma regla que la bandeja. Quien se desactiva o pasa a Civil deja de recibir
-- avisos sin tocar esta tabla; quien se borra se lleva sus teléfonos por la clave foránea.
CREATE TABLE IF NOT EXISTS device_push_token (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       CHAR(36)     NOT NULL,

  -- ASCII y binario a propósito. Un token de FCM son caracteres ASCII y distingue mayúsculas: con la
  -- colación de la tabla (utf8mb4_unicode_ci, que no las distingue) dos tokens que solo difieren en
  -- una mayúscula chocarían en el índice único. Y en ASCII el índice ocupa 512 bytes en vez de 2048,
  -- holgado dentro del límite de InnoDB incluso con el formato de fila antiguo (767).
  token         VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,

  platform      VARCHAR(16)  NOT NULL,             -- 'android'
  app_version   VARCHAR(32)      NULL,             -- versión de la app que lo registró (diagnóstico)

  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Cada arranque de la app vuelve a registrar el token: esto dice cuándo se vio vivo por última vez.
  last_seen_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_device_push_token (token),
  KEY idx_device_push_token_user (user_id),
  -- Borrar la cuenta borra sus teléfonos: un token huérfano seguiría recibiendo avisos de planta.
  CONSTRAINT fk_device_push_token_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
