/**
 * Puntero de «hasta qué aviso ya se anunció en el panel» (`ptap_last_notified_id`).
 *
 * Vive aparte, sin React Native ni Expo, para poder probarlo con `node --test`: es la pieza que
 * decide si un aviso de planta llega al panel o se da por anunciado sin haber salido nunca, y eso
 * no se puede dejar a una prueba manual en un teléfono.
 *
 * El fallo que corrige: antes el puntero saltaba al id más alto ANTES de publicar y sin mirar si se
 * había publicado. Si `scheduleNotificationAsync` fallaba —o el proceso moría a mitad—, el aviso
 * quedaba marcado como anunciado y ya no volvía a intentarse.
 */

/**
 * Siguiente valor del puntero tras un ciclo de sincronización.
 *
 * Avanza por los candidatos MAYORES que `previo`, de menor a mayor, mientras estén resueltos, y se
 * detiene antes del primero que no lo esté. «Resuelto» es una de dos cosas:
 *  - aplazado: no tocaba sonar (no molestar, tipo silenciado) y queda en la lista de diferidos, que
 *    lo vuelve a evaluar en cada ciclo sin necesidad del puntero;
 *  - publicado: el sistema aceptó la notificación.
 *
 * Lo que falló y todo lo que va detrás se queda por encima del puntero y se reintenta en el próximo
 * ciclo. Que se repita alguno ya publicado es el precio, y es barato: los avisos de planta se
 * publican con `identifier = n-<id>`, así que Android reemplaza la notificación en vez de duplicarla.
 *
 * Los candidatos con id ≤ `previo` (diferidos de una franja anterior) no mueven el puntero, ni hacia
 * delante ni hacia atrás: ya estaba por encima de ellos. Nunca devuelve menos que `previo`.
 */
export function siguientePuntero(
  previo: number,
  idsCandidatos: readonly number[],
  resueltos: ReadonlySet<number>,
): number {
  const porEncima = [...new Set(idsCandidatos)].filter((id) => id > previo).sort((a, b) => a - b);

  let puntero = previo;
  for (const id of porEncima) {
    if (!resueltos.has(id)) break;
    puntero = id;
  }
  return puntero;
}
