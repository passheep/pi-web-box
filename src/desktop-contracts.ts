/** 桌面标签、消息中心与询问提醒共用的数据契约。 */
export type DesktopTab = { id: string; title: string; sessionId: string; url: string; loading: boolean; color: string; running: boolean };
export type DesktopState = { tabs: DesktopTab[]; activeId: string; maximized: boolean; unread: number; messagePanelOpen: boolean; maxTabs: number };
export type NoticeInput = { eventId?: string; sessionId?: string; sessionName?: string; message: string; level?: string; source?: string };
export type NoticeRecord = { sequence: number; eventId: string; sessionId: string; sessionName: string; message: string; level: string; source: string; createdAt: number };
export type NoticePage = { items: NoticeRecord[]; nextCursor: number | null; unread: number };
export type NoticeQuery = { before?: number; limit?: number };

/**
 * 页面上报的「等待用户输入」弹窗状态。
 * requestId 为弹窗请求 id：active 为 true 表示弹窗出现，false 表示已关闭（回答、取消或超时）。
 * 其余字段只在 active 时有值，主进程据此拼装提醒文案。
 */
export type AttentionReport = {
  sessionId: string;
  requestId: string;
  active: boolean;
  method?: string;
  title?: string;
  message?: string;
  optionCount?: number;
};
