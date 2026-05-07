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

function getCodexQuestionNotificationMessage(args) {
  const questions = getCodexQuestionNotificationQuestions(args);
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

function parseSessionIdFromRolloutPath(filePath) {
  const match = path
    .basename(filePath)
    .match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function normalizeInlineText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function getCodexQuestionNotificationQuestions(args) {
  return Array.isArray(args && args.questions)
    ? args.questions.filter(
        (question) => question && typeof question === "object" && !Array.isArray(question)
      )
    : [];
}

module.exports = {
  getCodexQuestionNotificationMessage,
  parseJsonObjectMaybe,
  parseSessionIdFromRolloutPath,
};
