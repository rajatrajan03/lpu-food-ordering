import { prisma } from "../lib/prisma";
import type { Student } from "@prisma/client";
import { emptySessionState } from "../ai/tools";

export const WELCOME_TEXT =
  "Welcome to LPU Food Ordering! 👋 Before we start, what's your University Registration Number?";
export const ASK_NAME_TEXT = "Got it! And what would you like me to call you?";
export const NAME_RETRY_TEXT = "That doesn't look like a name — what would you like me to call you?";
export function onboardedConfirmationText(name: string): string {
  return `Nice to meet you, ${name}! You're all set — tell me what you're craving, or say "hi" to see your options.`;
}

// Matches GREETING_PATTERN in conversationEngine.ts plus a few more common
// one-word replies — a student answering "what should I call you?" with one
// of these almost certainly isn't giving their actual name (they're either
// re-greeting, confused, or just acknowledging), so it shouldn't get saved
// as one.
const NOT_A_NAME = /^(hi+|hello+|hey+|hlo|yo|ok(ay)?|k|thanks?|thank you|start|menu|yes|no|sure)$/i;

/** Rejects obvious non-name input so onboarding never silently stores a greeting/filler word as the student's name. */
export function isPlausibleName(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return false;
  if (NOT_A_NAME.test(trimmed)) return false;
  return true;
}

/** Below this gap since lastSeen, treat it as the same ongoing conversation — no return greeting. */
const MIN_GAP_FOR_GREETING_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Finds the student by WhatsApp number, creating a bare row (no name/registration
 * yet) on first contact. Does NOT touch lastSeen — the caller decides when the
 * onboarding/greeting flow has actually resolved before recording a visit, so a
 * student who never gets past "what's your reg number?" doesn't rack up return
 * greetings for messages that were really onboarding answers.
 */
export async function findOrCreateStudent(whatsappNumber: string): Promise<{ student: Student; isNewStudent: boolean }> {
  const existing = await prisma.student.findUnique({ where: { whatsappNumber } });
  if (existing) return { student: existing, isNewStudent: false };

  const created = await prisma.student.create({
    data: { whatsappNumber, sessionState: emptySessionState() as unknown as object },
  });
  return { student: created, isNewStudent: true };
}

export async function saveRegistrationNumber(studentId: string, rawValue: string): Promise<Student> {
  return prisma.student.update({
    where: { id: studentId },
    data: { registrationNumber: rawValue.trim().slice(0, 60) },
  });
}

export async function saveName(studentId: string, rawValue: string): Promise<Student> {
  return prisma.student.update({
    where: { id: studentId },
    data: { name: rawValue.trim().slice(0, 60) },
  });
}

/** Marks a real visit — bumps lastSeen/updatedAt and reactivates a previously-inactive student. */
export async function touchLastSeen(studentId: string): Promise<void> {
  await prisma.student.update({
    where: { id: studentId },
    data: { lastSeen: new Date(), isActive: true },
  });
}

/**
 * Personalized "welcome back" line based on the gap since the student's last
 * visit, or null if the gap is short enough that this reads as the same
 * conversation (no greeting needed — the AI just answers normally).
 */
export function greetingForReturn(lastSeen: Date, name: string | null): string | null {
  const gapMs = Date.now() - lastSeen.getTime();
  if (gapMs < MIN_GAP_FOR_GREETING_MS) return null;

  const who = name ?? "there";
  const days = gapMs / DAY_MS;

  if (days < 1) return `Welcome back, ${who}! 👋`;
  if (days < 7) return `Hey ${who}, good to see you again this week! 👋`;
  if (days < 30) return `Hi ${who}! It's been a little while — welcome back. 🙂`;
  if (days < 180) return `Long time no see, ${who}! Great to have you back.`;
  return `Whoa, it's been ages, ${who}! Welcome back to LPU Food Ordering. 🎉`;
}

/** For the Super Admin dashboard's Students view — most recently active first. */
export async function listStudents(params: { limit?: number; offset?: number } = {}) {
  const { limit = 50, offset = 0 } = params;
  return prisma.student.findMany({
    orderBy: { lastSeen: "desc" },
    skip: offset,
    take: limit,
    select: {
      id: true,
      whatsappNumber: true,
      name: true,
      registrationNumber: true,
      preferredLanguage: true,
      isActive: true,
      createdAt: true,
      lastSeen: true,
      _count: { select: { orders: true } },
      preference: {
        select: {
          favoriteMealPeriod: true,
          ordersAnalyzed: true,
          favoriteStall: { select: { name: true } },
        },
      },
    },
  });
}

export async function countStudents() {
  return prisma.student.count();
}
