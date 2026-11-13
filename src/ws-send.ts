/**
 * Return false when a browser WebSocket is closed or rejects a message.
 * A local send means only that the browser accepted the frame, NOT that
 * the remote server acknowledged the operation.
 */
export function trySendJson(
  socket: { readyState: number; send(data: string): void },
  payload: unknown
): boolean {
  if (socket.readyState !== 1) return false; // WebSocket.OPEN
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}
