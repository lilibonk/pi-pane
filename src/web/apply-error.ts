/** Keep the saved-change banner accurate after a refresh or on another page. */
export function explainApplyError(message: string): string {
  const known: Record<string, string> = {
    "An extension declined to reload the session. The change is saved; try again later.": "有扩展拒绝了重新加载。更改已保存，可以稍后再应用。",
    "Wait until replies, queued messages and dialogs have settled, then apply.": "pi 正在回复、有待发消息或有待回答的对话框，结束后再应用。",
    "No session is running to apply this to.": "当前没有运行中的会话可以应用这项更改。",
  };
  return known[message] ?? message;
}
