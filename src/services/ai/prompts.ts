import type { AIMessage } from '@/types/models';

/** Central prompt library. All learner-facing output is in the user's UI language (Chinese). */

const TUTOR_SYSTEM =
  'You are a friendly English tutor for Chinese-speaking learners. Answer in Simplified Chinese unless asked otherwise; quote English examples in English. Be concise and practical.';

export function explainWordPrompt(word: string, context?: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    {
      role: 'user',
      content: `请讲解英文单词 "${word}"${context ? `（出现在这句话里："${context}"）` : ''}：给出核心含义、在该语境中的意思、1-2 个常见搭配和一个例句（附中文翻译）。`,
    },
  ];
}

export function explainGrammarPrompt(sentence: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    {
      role: 'user',
      content: `请分析这句英文的语法结构，指出主干、从句、时态和值得学习的语法点：\n\n"${sentence}"`,
    },
  ];
}

export function explainDifficultWordsPrompt(sentence: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    {
      role: 'user',
      content: `列出这句英文里对中级学习者较难的单词或短语，逐个给出释义和记忆提示：\n\n"${sentence}"`,
    },
  ];
}

export function rewritePrompt(sentence: string, level: 'easier' | 'advanced' | 'business'): AIMessage[] {
  const instruction = {
    easier: '改写成更简单、初学者友好的英文，保持原意',
    advanced: '改写成更高级、地道的英文表达，保持原意',
    business: '改写成正式的商务英语，保持原意',
  }[level];
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    { role: 'user', content: `请把这句英文${instruction}，给出 1-2 个版本并简要说明改动：\n\n"${sentence}"` },
  ];
}

export function summarizePrompt(pageTitle: string, pageText: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    {
      role: 'user',
      content: `请用中文总结这篇文章的要点（3-5 条），并列出 3 个值得学习的英文表达：\n\n标题：${pageTitle}\n\n${pageText.slice(0, 6000)}`,
    },
  ];
}

export function naturalTranslatePrompt(text: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    { role: 'user', content: `请把下面的英文翻译成自然流畅的中文，不要逐字直译：\n\n"${text}"` },
  ];
}

export function flashcardsPrompt(pageText: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    {
      role: 'user',
      content: `从下面的文章中挑出 5 个值得学习的单词或短语，做成抽认卡格式（正面：英文+例句；背面：中文释义）：\n\n${pageText.slice(0, 6000)}`,
    },
  ];
}

export function generateExamplesPrompt(word: string): AIMessage[] {
  return [
    { role: 'system', content: TUTOR_SYSTEM },
    { role: 'user', content: `请用英文单词 "${word}" 造 3 个不同场景的例句，每句附中文翻译。` },
  ];
}

/** Structured enrichment for the dictionary card. Must return JSON. */
export function dictionaryEnrichmentPrompt(word: string): AIMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a lexicographer. Respond with ONLY a JSON object, no prose: {"cefr": "A1|A2|B1|B2|C1|C2", "collocations": ["...", "..."], "meaningZh": "简体中文核心释义"}',
    },
    { role: 'user', content: word },
  ];
}

export function pageChatSystemPrompt(pageTitle: string, pageText: string): AIMessage {
  return {
    role: 'system',
    content: `${TUTOR_SYSTEM}\n\nThe user is reading this page. Use it as context when relevant.\n\nTitle: ${pageTitle}\n\nContent:\n${pageText.slice(0, 12000)}`,
  };
}
