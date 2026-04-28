const path = require("path");

function parseJsonObjectMaybe(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return typeof value === "object" && !Array.isArray(value) ? value : null;
}

function getCodexInputRequestDescriptor(args) {
  const questions = getCodexInputRequestQuestions(args);
  if (!questions.length) {
    return "request_user_input";
  }

  const parts = questions.slice(0, 3).map((question, index) => {
    return (
      sanitizeDedupeDescriptorPart(question.id) ||
      sanitizeDedupeDescriptorPart(question.header) ||
      sanitizeDedupeDescriptorPart(question.question) ||
      `q${index + 1}`
    );
  });

  return `request_user_input:${parts.join(",")}:${questions.length}`;
}

function getCodexInputRequestMessage(args) {
  const questions = getCodexInputRequestQuestions(args);
  if (!questions.length) {
    return "Waiting for your input";
  }

  const firstQuestion =
    normalizeInlineText(questions[0].question) || normalizeInlineText(questions[0].header);

  if (!firstQuestion) {
    return "Waiting for your input";
  }

  return questions.length > 1 ? `${firstQuestion} (+${questions.length - 1} more)` : firstQuestion;
}

function buildSessionEventDedupeKey({ sessionId, turnId, fallbackId, eventKind, descriptor }) {
  return [
    sessionId || "unknown",
    eventKind || "event",
    turnId || fallbackId || "unknown",
    descriptor || "",
  ].join("|");
}

function parseSessionIdFromRolloutPath(filePath) {
  const match = path
    .basename(filePath)
    .match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function normalizeInlineText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function sanitizeDedupeDescriptorPart(value) {
  return normalizeInlineText(value).replace(/[|]/g, "/").slice(0, 80);
}

function getCodexInputRequestQuestions(args) {
  return Array.isArray(args && args.questions)
    ? args.questions.filter(
        (question) => question && typeof question === "object" && !Array.isArray(question)
      )
    : [];
}

module.exports = {
  buildSessionEventDedupeKey,
  getCodexInputRequestDescriptor,
  getCodexInputRequestMessage,
  parseJsonObjectMaybe,
  parseSessionIdFromRolloutPath,
};
