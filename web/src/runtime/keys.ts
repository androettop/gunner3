/** A key as `KeyboardEvent.code` names it, which is what Excalibur reads. */
export type KeyCode = string;

/**
 * Hands the game a key it was not typed.
 *
 * Excalibur listens for keys on the window and reads `code`, so that is what is sent, and it is
 * a real KeyboardEvent rather than anything the runtime keeps to itself: a game played with a
 * thumb or with a pad is playing by its own controls, and nothing in it knows the difference.
 *
 * Dispatched at the window, which is the whole of the event's path: a page listening on the
 * document for the first key of the session, as this one does to let the audio out, is not told
 * a key was struck by something that is not a player.
 */
export function sendKey(type: 'keydown' | 'keyup', code: KeyCode): void {
  window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
}
