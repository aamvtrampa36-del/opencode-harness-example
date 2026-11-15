const SPECIALIZATION_PREFIX = "opencode-specialization:";

function key(object: string, session: string): string {
  return SPECIALIZATION_PREFIX + object + ":" + session;
}

export function readSessionSpecialization(
  storage: Pick<Storage, "getItem">,
  object: string,
  session: string
): string {
  return storage.getItem(key(object, session)) ?? "";
}

export function saveSessionSpecialization(
  storage: Pick<Storage, "setItem">,
  object: string,
  session: string,
  specialization: string
): void {
  storage.setItem(key(object, session), specialization);
}
