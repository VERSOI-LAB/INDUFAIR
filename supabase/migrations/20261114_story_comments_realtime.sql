-- 이야기 글을 보고 있는 동안 새 댓글이 바로 보이도록 실시간(Realtime)에 댓글 테이블 추가
-- (읽기 권한은 RLS 그대로: 공개 글의 보이는 댓글만 전달됨)
do $$
begin
  alter publication supabase_realtime add table public.story_comments;
exception when duplicate_object then null; -- 이미 들어 있으면 그대로
end $$;
