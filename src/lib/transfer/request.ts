import { z } from "zod";
import { CASE_OUTCOMES, CHANNELS } from "../domain";
import { MAX_TEXT_LENGTH } from "../api/analyze-request";

export const MAX_AMOUNT = 100_000_000;

const amount = z
  .number({ error: "amount: нужна сумма в тенге" })
  .int("amount: целое число тенге")
  .positive("amount: сумма должна быть больше нуля")
  .max(MAX_AMOUNT, "amount: слишком большая сумма");

const messageText = z.string({ error: "messageText: нужна строка" }).trim().max(MAX_TEXT_LENGTH, `Текст длиннее ${MAX_TEXT_LENGTH} символов`).optional();

/**
 * Реквизиты получателя (номер карты, телефон) на сервер не передаются вовсе —
 * только признак «новый получатель».
 */
export const AssessRequestSchema = z.object({
  amount,
  newRecipient: z.boolean({ error: "newRecipient: true или false" }),
  messageText,
  /** Сигнал устройства: во время перевода идёт телефонный разговор. */
  onCall: z.boolean({ error: "onCall: true или false" }).optional(),
}, { error: "Тело запроса должно быть JSON-объектом" });

export const CaseRequestSchema = AssessRequestSchema.extend({
  channel: z.enum(CHANNELS, { error: "channel: допустимы sms, call, messenger, email" }).optional(),
  outcome: z.enum(CASE_OUTCOMES, { error: "outcome: недопустимое значение" }),
});
