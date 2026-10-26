// views.js — server-rendered pages. No template engine; plain template literals.
export {
  teamsBoardPage, gamesStrip, leaderboardPage,
} from './views/pages/teams.js';
export {
  ladderPage, ladderBoardPage,
} from './views/pages/ladder.js';
export {
  statusPage, demoResetPage, logoutPage, confirmActionPage, waiverPage, bannerPage,
} from './views/pages/misc.js';
export {
  mdToHtml, legalPage,
} from './views/pages/legal.js';
export {
  peoplePage, exportPage, sharePage,
} from './views/pages/people.js';
export {
  pcoAdminPage,
} from './views/pages/pco.js';
export {
  programsAdminPage,
} from './views/pages/programs.js';
export {
  kioskPage,
} from './views/pages/kiosk.js';
export {
  analyticsPage, runHistoryPage, auditViewerPage,
} from './views/pages/analytics.js';
export {
  adminPage,
} from './views/pages/admin.js';
export {
  threadPage,
} from './views/pages/messages.js';
export {
  runPage, pickleballPage,
} from './views/pages/run.js';
export {
  runsPage, runJoinPage, pkJoinPage, pastRunPage, seasonPage,
} from './views/pages/runs-hub.js';
export {
  friendsSearchFragment, friendsPage,
} from './views/pages/friends.js';
export {
  demoProfileCard, profileCard, profilePage, profileTabPage,
} from './views/pages/profile.js';
export {
  chatPage, runChatPage, chatOlderFragment, chatLockedPage,
} from './views/pages/chat.js';
export {
  checkinPage, claimResultPage,
} from './views/pages/checkin.js';
export {
  invitePage,
} from './views/pages/invite.js';
export {
  loginPage,
} from './views/pages/login.js';
export {
  intakePage,
} from './views/pages/intake.js';
export {
  BUILD_VER, setDemoMode,
} from './views/shell.js';
export {
  STICKERS,
} from './views/chat-ui.js';
export {
  setAvatarMap, avatarUrlFor, setProgramMeta,
} from './views/components.js';
export {
  APP_JS,
} from './views/client-app.js';
