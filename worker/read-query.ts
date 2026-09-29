// Caller supplies a bound parameter or an internal column expression, never input.
export function unreadMessageSql(person: string) {
  return `m.deleted_at IS NULL AND m.author_id<>${person}
    AND m.seq>COALESCE((SELECT last_seq FROM room_reads rr WHERE rr.room_id=m.room_id AND rr.person_id=${person}),0)
    AND NOT EXISTS(SELECT 1 FROM message_reads mr WHERE mr.message_id=m.id AND mr.person_id=${person})`;
}
