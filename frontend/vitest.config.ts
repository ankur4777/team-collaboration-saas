import {defineConfig} from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins:[react()],
  test:{environment:'jsdom',include:['src/EmailPanel.test.tsx','src/ChatNotificationBell.test.tsx','src/MeetingsPanel.test.tsx', 'src/CallAccessibility.test.tsx', 'src/WorkspaceCalendar.test.tsx', 'src/SharedFilesPanel.test.tsx', 'src/OrganizationWork.test.tsx', 'src/ChatPanelIdentity.test.tsx', 'src/ProfileMenu.test.tsx'],restoreMocks:true},
});



