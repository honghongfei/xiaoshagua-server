import { describe, it, expect } from 'vitest';
import { ChatSend, PidWithKind } from '../src/util/schema.js';

describe('ChatSend', () => {
  it('accepts world', () => {
    expect(ChatSend.safeParse({ channel: 'world', text: 'hi' }).success).toBe(true);
  });
  it('accepts whisper with target', () => {
    expect(ChatSend.safeParse({ channel: 'whisper', text: 'psst', targetPid: 42 }).success).toBe(true);
  });
  it('rejects unknown channel', () => {
    expect(ChatSend.safeParse({ channel: 'shout', text: 'hi' }).success).toBe(false);
  });
  it('rejects empty text', () => {
    expect(ChatSend.safeParse({ channel: 'world', text: '' }).success).toBe(false);
  });
  it('rejects >200 chars', () => {
    expect(ChatSend.safeParse({ channel: 'world', text: 'a'.repeat(201) }).success).toBe(false);
  });
});

describe('PidWithKind', () => {
  it('accepts friend', () => {
    expect(PidWithKind.safeParse({ pid: 7, kind: 'friend' }).success).toBe(true);
  });
  it('accepts block', () => {
    expect(PidWithKind.safeParse({ pid: 7, kind: 'block' }).success).toBe(true);
  });
  it('rejects bad kind', () => {
    expect(PidWithKind.safeParse({ pid: 7, kind: 'enemy' }).success).toBe(false);
  });
});
