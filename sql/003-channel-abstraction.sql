-- Migrate chat_id from integer to text with channel prefix.
-- Existing rows get 'telegram:' prefix automatically.
ALTER TABLE assistant.messages
  ALTER COLUMN chat_id TYPE text USING 'telegram:' || chat_id;

-- Migrate defaultChatId in state store to defaultRecipientId
UPDATE assistant.state
  SET key = 'defaultRecipientId',
      value = to_jsonb('telegram:' || (value #>> '{}'))
  WHERE namespace = 'system' AND key = 'defaultChatId';
