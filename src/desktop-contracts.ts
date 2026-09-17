/** 桌面标签和消息中心共用的数据契约。 */
export type DesktopTab = { id: string; title: string; sessionId: string; url: string; loading: boolean; color: string; running: boolean };
export type DesktopState = { tabs: DesktopTab[]; activeId: string; maximized: boolean; unread: number; messagePanelOpen: boolean; maxTabs: number };
export type NoticeInput = { eventId?: string; sessionId?: string; sessionName?: string; message: string; level?: string; source?: string };
export type NoticeRecord = { sequence: number; eventId: string; sessionId: string; sessionName: string; message: string; level: string; source: string; createdAt: number };
export type NoticePage = { items: NoticeRecord[]; nextCursor: number | null; unread: number };
export type NoticeQuery = { before?: number; limit?: number };
