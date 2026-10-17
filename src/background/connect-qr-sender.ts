/** Only the internal manager may request plaintext pairing credentials. */
export function isConnectQrSender(sender: { id?: string; url?: string } | undefined, runtimeId: string, managerUrl: string): boolean {
  if (!sender || sender.id !== runtimeId || !sender.url) return false;
  try {
    const actual = new URL(sender.url);
    const expected = new URL(managerUrl);
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname && !actual.hash;
  } catch { return false; }
}
