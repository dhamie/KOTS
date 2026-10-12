import type { Notification } from "@kots/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/http";
import { onLive } from "../../api/live";
import { when } from "../format";

/** The bell in the top bar: unread count, the latest notifications, and a jump to the panel each one is about. */
export function NotificationBell(props: { onOpen: (target: Notification["target"]) => void }) {
  const { onOpen } = props;
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api
      .notifications()
      .then((page) => {
        setItems(page.items);
        setUnread(page.unread);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => load(), [load]);
  useEffect(
    () =>
      onLive((e) => {
        if (e.type === "resync") load();
        if (e.type !== "notification") return;
        setItems((list) => [e.notification, ...list.filter((n) => n.id !== e.notification.id)].slice(0, 20));
        setUnread((n) => n + 1);
      }),
    [load],
  );

  const select = (n: Notification) => {
    if (!n.read) {
      setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
      api.readNotification(n.id).catch(() => undefined);
    }
    setOpen(false);
    onOpen(n.target);
  };

  const readAll = () => {
    setItems((list) => list.map((x) => ({ ...x, read: true })));
    setUnread(0);
    api.readAllNotifications().catch(() => undefined);
  };

  return (
    <>
      <button type="button" className="link bell" aria-label={`Notifications, ${unread} unread`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <span className="badge" data-testid="unread-notifications">{unread}</span>}
      </button>
      {open && (
        <section className="panel notifications" aria-label="Notifications">
          <h2>Notifications</h2>
          {unread > 0 && (
            <button type="button" className="link small" onClick={readAll}>
              Mark all read
            </button>
          )}
          {items.length === 0 && <p className="muted small">Nothing yet.</p>}
          <ul className="list">
            {items.map((n) => (
              <li key={n.id} className={n.read ? "" : "unread"}>
                <button type="button" className="link" onClick={() => select(n)}>
                  {n.body}
                </button>
                <span className="muted small">{when(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
