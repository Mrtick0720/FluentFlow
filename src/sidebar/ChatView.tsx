import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { activeTabId } from '@/hooks/useActiveTab';
import { pageChatSystemPrompt } from '@/services/ai/prompts';
import {
  AI_STREAM_PORT,
  sendRequest,
  sendToTab,
  type AIStreamEvent,
  type AIStreamRequest,
} from '@/shared/messages';
import type { AIConversation, AIMessage } from '@/types/models';

const QUICK_PROMPTS = [
  '总结这篇文章的要点',
  '解释这一页里最难的 5 个单词',
  '把选中的内容翻译得更自然',
  '这页的语法有什么值得学习的？',
  '用这页的内容出 5 张抽认卡',
];

export function ChatView({ aiConfigured }: { aiConfigured: boolean }) {
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [history, setHistory] = useState<AIConversation[]>([]);
  const systemRef = useRef<AIMessage | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void sendRequest('conversations.list', null).then(setHistory, () => {});
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function loadPageContext() {
    const tabId = await activeTabId();
    if (tabId === undefined) return;
    try {
      const ctx = await sendToTab(tabId, 'content.getPageContext', null);
      systemRef.current = pageChatSystemPrompt(ctx.title, ctx.text);
      setPageTitle(ctx.title);
    } catch {
      setPageTitle(null);
    }
  }

  function send(text: string) {
    const content = text.trim();
    if (!content || streaming) return;
    const userMsg: AIMessage = { role: 'user', content };
    const outgoing: AIMessage[] = [
      ...(systemRef.current ? [systemRef.current] : []),
      ...messages,
      userMsg,
    ];
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    const port = chrome.runtime.connect({ name: AI_STREAM_PORT });
    port.onMessage.addListener((event: AIStreamEvent) => {
      if (event.type === 'chunk') {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1]!;
          next[next.length - 1] = { ...last, content: last.content + event.text };
          return next;
        });
      } else {
        if (event.type === 'error') {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1]!;
            next[next.length - 1] = {
              ...last,
              content: last.content || `⚠️ ${event.error.message}`,
            };
            return next;
          });
        }
        setStreaming(false);
        port.disconnect();
      }
    });
    port.postMessage({ messages: outgoing } satisfies AIStreamRequest);
  }

  async function saveConversation() {
    if (messages.length === 0) return;
    const title = messages.find((m) => m.role === 'user')?.content.slice(0, 40) ?? '对话';
    const saved = await sendRequest('conversations.save', {
      id: '',
      title,
      pageTitle: pageTitle ?? undefined,
      messages,
      createdAt: 0,
      updatedAt: 0,
    });
    setHistory((prev) => [saved, ...prev.filter((c) => c.id !== saved.id)]);
  }

  if (!aiConfigured) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          AI 助手需要配置提供方（Anthropic / OpenAI / 自定义端点）。
        </p>
        <Button variant="primary" onClick={() => chrome.runtime.openOptionsPage()}>
          去设置
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-100 p-2 dark:border-slate-800">
        <Button onClick={() => void loadPageContext()} className="text-xs">
          {pageTitle ? `📄 ${pageTitle.slice(0, 24)}…` : '载入当前页面作为上下文'}
        </Button>
        <Button onClick={() => void saveConversation()} disabled={messages.length === 0} className="text-xs">
          保存
        </Button>
        <Button
          onClick={() => {
            setMessages([]);
            systemRef.current = null;
            setPageTitle(null);
          }}
          className="text-xs"
        >
          新对话
        </Button>
        {history.length > 0 && (
          <select
            className="ml-auto max-w-[130px] rounded-lg border border-slate-200 bg-white px-1 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            value=""
            onChange={(e) => {
              const conv = history.find((c) => c.id === e.target.value);
              if (conv) setMessages(conv.messages.filter((m) => m.role !== 'system'));
            }}
            aria-label="历史对话"
          >
            <option value="">历史对话…</option>
            {history.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.length === 0 && (
          <div className="space-y-2 pt-6">
            <p className="text-center text-xs text-slate-400">试试这些：</p>
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                onClick={() => {
                  void loadPageContext().then(() => send(q));
                }}
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[88%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'ml-auto bg-indigo-500 text-white'
                : 'bg-slate-100 dark:bg-slate-800'
            }`}
          >
            {m.content || (streaming && i === messages.length - 1 ? '…' : '')}
          </div>
        ))}
      </div>

      <form
        className="flex gap-2 border-t border-slate-100 p-2 dark:border-slate-800"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="问点什么…（回车发送）"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
        />
        <Button variant="primary" type="submit" disabled={streaming || !input.trim()}>
          {streaming ? '…' : '发送'}
        </Button>
      </form>
    </div>
  );
}
