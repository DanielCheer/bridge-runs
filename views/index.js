// views/index.js — the view layer's public surface. Server-rendered pages as plain template-literal
// functions (no template engine); every importer outside views/ imports from here.
//
// Layout: util.js (escaping, date labels) → components.js (icons, avatars, nav, cards) →
// chat-ui.js (bubbles, composer, chat room) → shell.js (HEAD, header, footers, BUILD_VER) →
// pages/*.js (one module per page family). client-app.js is APP_JS, the browser engine served at
// /app.js. Views import only config.js and each other, never the engine or the database: routes
// read the data and pass it in.
export { APP_JS } from './client-app.js';
export { BUILD_VER, setDemoMode } from './shell.js';
export { setAvatarMap, avatarUrlFor, setProgramMeta } from './components.js';
export { STICKERS } from './chat-ui.js';

export { intakePage } from './pages/intake.js';
export { loginPage } from './pages/login.js';
export { invitePage } from './pages/invite.js';
export { checkinPage, claimResultPage } from './pages/checkin.js';
export { chatPage, runChatPage, chatOlderFragment, chatLockedPage } from './pages/chat.js';
export { demoProfileCard, profileCard, profilePage, profileTabPage } from './pages/profile.js';
export { friendsSearchFragment, friendsPage } from './pages/friends.js';
export { runsPage, runJoinPage, pkJoinPage, pastRunPage, seasonPage } from './pages/runs-hub.js';
export { runPage, pickleballPage } from './pages/run.js';
export { threadPage } from './pages/messages.js';
export { adminPage } from './pages/admin.js';
export { analyticsPage, runHistoryPage, auditViewerPage } from './pages/analytics.js';
export { kioskPage } from './pages/kiosk.js';
export { programsAdminPage } from './pages/programs.js';
export { pcoAdminPage } from './pages/pco.js';
export { peoplePage, exportPage, sharePage } from './pages/people.js';
export { mdToHtml, legalPage } from './pages/legal.js';
export { statusPage, demoResetPage, logoutPage, confirmActionPage, waiverPage, bannerPage } from './pages/misc.js';
export { ladderPage, ladderBoardPage } from './pages/ladder.js';
export { teamsBoardPage, gamesStrip, leaderboardPage } from './pages/teams.js';
