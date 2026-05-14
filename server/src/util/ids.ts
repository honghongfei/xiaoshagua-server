import { customAlphabet } from 'nanoid';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

const _token = customAlphabet(ALPHABET, 32);
const _short = customAlphabet(ALPHABET, 10);

export function newToken(): string {
  return _token();
}

export function newShortId(): string {
  return _short();
}
