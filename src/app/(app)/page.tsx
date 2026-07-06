import { PageHeader } from "@/components/page-header";
import { Chat } from "@/components/chat";

/** Chat tab — 3-zone mentor with smart input (Loop 6): plain text talks,
 * `>>` logs a memo, `/` runs a command, and a chip switches persona. */
export default function ChatPage() {
  return (
    <div>
      <PageHeader
        title="Chat"
        subtitle="Talk to your mentor. Plain text asks · >> logs a memo · / runs a command."
      />
      <Chat />
    </div>
  );
}
