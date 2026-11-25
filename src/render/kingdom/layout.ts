/**
 * Where things are DRAWN on the kingdom map, shared by the renderer and the
 * pen so that what you see is exactly what you can grab.
 *
 * The one case that needs it: the king's counter. The king starts standing in
 * Cold Hearth, and drawn on top of the hamlet's glyph the two would be one
 * target -- a tap there could mean "the king" or "the hamlet" (U1-14). So the
 * counter is set a fixed distance ABOVE the king's true point, with a stem down
 * to it, like a counter placed beside a town on a map table. The offset is in
 * screen pixels (it is a drawing decision), so in map miles it depends on the
 * zoom; the recogniser is handed the result in miles and never needs to know.
 */

/** Screen pixels from the king's true point up to the centre of his counter. */
export const KING_COUNTER_OFFSET_PX = 30;
/** Radius of the king's counter, screen pixels. */
export const KING_COUNTER_RADIUS_PX = 13;

export type MapPoint = { readonly x: number; readonly y: number };

/** The centre of the king's counter, in map miles, for a true position and a zoom. */
export function kingCounterAt(truePos: MapPoint, pxToWorld: number): MapPoint {
  return { x: truePos.x, y: truePos.y - KING_COUNTER_OFFSET_PX * pxToWorld };
}
