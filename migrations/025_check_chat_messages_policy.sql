-- Check the chat_messages SELECT policy to see if it's causing recursion
SELECT 
  policyname,
  cmd as operation,
  qual as using_expression
FROM pg_policies 
WHERE tablename = 'chat_messages'
  AND cmd = 'SELECT';

-- The using_expression should show how it checks session_participants
-- If it contains a subquery that checks session_participants, and session_participants
-- policy also checks something that eventually checks chat_messages, that could cause recursion

