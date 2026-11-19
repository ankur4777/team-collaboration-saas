import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],
  test:{environment:'jsdom',include:['src/EmailPanel.test.tsx','src/ChatNotificationBell.test.tsx','src/MeetingsPanel.test.tsx'],restoreMocks:true},
});


