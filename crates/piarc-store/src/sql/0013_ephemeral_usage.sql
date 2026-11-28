-- Side chats have no JSONL. Keep their billed requests when rebuilding the index and
-- retain workspace ownership even before the main session writes its first response.
ALTER TABLE usage_records ADD COLUMN ephemeral_workspace TEXT;
