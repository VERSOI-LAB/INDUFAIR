-- 이야기 댓글 삭제 고침
--   댓글을 status='deleted' 로 바꾸면 '보이는 댓글만 읽기' 정책을 통과하지 못해
--   "new row violates row-level security policy" 로 막히던 문제 → 본인 댓글만 지우는 함수로
create or replace function public.story_delete_comment(p_id bigint)
returns text language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null then return 'login_required'; end if;
  update public.story_comments set status = 'deleted'
  where id = p_id and author_id = auth.uid() and status = 'active';
  get diagnostics n = row_count;
  return case when n = 1 then 'ok' else 'not_found' end;
end $$;
revoke execute on function public.story_delete_comment(bigint) from public, anon;
grant execute on function public.story_delete_comment(bigint) to authenticated;
