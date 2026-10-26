// routes/friends.js — the Friends tab: friends, follows and blocks, directory search, friends'
// games, and persistent parties (create, invite, accept, decline, remove, leave).
import db from '../db.js';
import { requireLogin } from '../auth.js';
import { friendsPage, friendsSearchFragment } from '../views/index.js';
import { lc } from '../lib/email.js';
import { rateLimited } from '../lib/rate-limit.js';
import { safeNextPath } from '../lib/http.js';
import { isMinor, stmtApplicantById } from '../engine/applicants.js';
import { annPanel } from '../engine/announcements.js';
import {
  stmtPartyInvitesFor, stmtPartyMemberRows, myPersistentParty, partyCap, stmtPartyLedBy,
  persistentPartyActive, stmtPartyRow,
} from '../engine/parties.js';
import {
  friendsGamesFor, iBlocked, followersOf, stmtBlockedByMe, followingOf, peopleByEmails,
  searchResultsFor, friendRequest, friendAccept, friendDecline, friendRemove, doBlock, doUnblock,
  doFollow, doUnfollow, blockedPair, isFollowing,
} from '../engine/social.js';
import { chatProgramFor, chatCountsFor } from '../engine/chat.js';
import { unreadCount } from '../engine/messages.js';
import { requirePlayer } from './guards.js';
import { audit } from '../lib/audit.js';

// Friend/block mutations. Shared wrapper: gate → resolve target id→email → run handler → swap
// back to the page the form was on (safeNextPath guards the redirect; defaults to /friends).
function socialRoute(fn) {
  return (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.redirect('/status');
    const back = (typeof req.body.back === 'string' && req.body.back) ? safeNextPath(req.body.back) : '/friends';
    const t = db.prepare('SELECT email, status FROM applicants WHERE id = ?').get(Number(req.body.id) || 0);
    if (t && t.email) fn(req.userEmail, t.email, t);
    res.redirect(back);
  };
}

// Friends-tab party data: my party (members + statuses), invites to me, and (leader-only) who I
// can still invite — people I FOLLOW, minus blocked pairs and people already committed elsewhere.
function friendsPartyDataFor(me) {
  me = lc(me);
  const maxSize = partyCap();
  const p = myPersistentParty(me);
  // Invites only render while uncommitted — once in a party, accept would refuse anyway (one
  // party per person), so showing them is a dead button.
  const invites = p ? [] : stmtPartyInvitesFor.all(me).map(r => {
    const ldr = peopleByEmails([r.leader_email]).get(lc(r.leader_email));
    return { partyId: r.party_id, name: r.name || '', leaderName: ldr?.full_name || r.leader_email };
  });
  let party = null, invitable = [];
  if (p) {
    const rows = [{ email: lc(p.leader_email), status: 'leader' }, ...stmtPartyMemberRows.all(p.id).map(m => ({ email: lc(m.email), status: m.status }))];
    const dir = peopleByEmails(rows.map(r => r.email));
    party = {
      id: p.id, name: p.name || '', isLeader: lc(p.leader_email) === me,
      members: rows.map(m => { const a = dir.get(m.email); return { id: a?.id || 0, name: a?.full_name || m.email, minor: isMinor(a), status: m.status }; }),
    };
    if (party.isLeader && rows.length < maxSize) {
      const inP = new Set(rows.map(r => r.email));
      invitable = [...peopleByEmails(followingOf(me)).values()]
        .filter(x => x.status === 'approved' && !/@guest\.local$/.test(x.email) && !inP.has(lc(x.email)) && !blockedPair(me, x.email) && !myPersistentParty(x.email))
        .map(x => ({ id: x.id, name: x.full_name })).sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  return { maxSize, party, invites, invitable };
}

export function mountFriends(app) {
  // Friends home — FOLLOW-only (mutual friend-requests dropped as redundant): live search +
  // following + followers (follow-back) + games (people you follow) + blocked.
  app.get('/friends', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.redirect('/status');
    const me = req.userEmail;
    const q = String(req.query.q || '').trim().slice(0, 60);
    const blk = stmtBlockedByMe.all(lc(me));
    const flwrs = followersOf(me);           // people who follow me
    const flwng = followingOf(me);           // people I follow
    const followingSet = new Set(flwng.map(lc));
    const dir = peopleByEmails([...blk.map(r => r.email), ...flwrs, ...flwng]);
    const shape = email => { const p = dir.get(lc(email)); return p ? { id: p.id, name: p.full_name, email: p.email } : null; };
    const blocked  = blk.map(r => shape(r.email)).filter(Boolean);
    const followers = flwrs.map(e => { const p = shape(e); return p ? { ...p, followsBack: followingSet.has(lc(e)) } : null; })
      .filter(p => p && !iBlocked(me, p.email)); // "Follow back" vs "Following ✓"; hide any I've blocked
    const following = flwng.map(shape).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const chatProgram = chatProgramFor(req);
    const cc = chatCountsFor(chatProgram || 1, gate.a.email, gate.a.id);
    res.send(friendsPage({
      q, results: searchResultsFor(me, q), blocked, followers, following, games: friendsGamesFor(me),
      party: friendsPartyDataFor(me),
      dmUnread: unreadCount(gate.a.email), groupUnread: cc.group, groupMention: cc.gm,
      chatProgram, ann: annPanel(gate.a.email),
    }));
  });
  // Typeahead fragment for the live search box (returns just the result rows).
  app.get('/friends/search', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res);
    if (!gate) return;
    if (!gate.a) return res.status(403).send('');
    if (rateLimited('friends-search', req.userEmail, 60, 60 * 1000)) return res.send('');
    res.send(friendsSearchFragment(searchResultsFor(req.userEmail, req.query.q)));
  });
  app.post('/friends/request', requireLogin, socialRoute((me, them, t) => {
    if (t.status !== 'approved' || /@guest\.local$/.test(them)) return;        // only friend real approved members
    if (!rateLimited('friend-req', me, 30, 10 * 60 * 1000)) friendRequest(me, them);
  }));
  app.post('/friends/accept',  requireLogin, socialRoute((me, them) => friendAccept(me, them)));
  app.post('/friends/decline', requireLogin, socialRoute((me, them) => friendDecline(me, them)));
  app.post('/friends/remove',  requireLogin, socialRoute((me, them) => friendRemove(me, them)));
  app.post('/friends/block',   requireLogin, socialRoute((me, them) => doBlock(me, them)));
  app.post('/friends/unblock', requireLogin, socialRoute((me, them) => doUnblock(me, them)));
  app.post('/friends/follow',  requireLogin, socialRoute((me, them, t) => {
    if (t.status !== 'approved' || /@guest\.local$/.test(them)) return;
    if (!rateLimited('friend-follow', me, 60, 10 * 60 * 1000)) doFollow(me, them);
  }));
  app.post('/friends/unfollow', requireLogin, socialRoute((me, them) => doUnfollow(me, them)));
}

export function mountFriendParties(app) {
  // Friends-tab party routes. Every mutation keys on req.userEmail (IDOR-safe: the party is resolved
  // via leader_email=me or the (party_id, me) member row; invitees resolve from applicant id server-
  // side). Violations redirect silently back to /friends (socialRoute pattern); forms are .swapform.
  app.post('/friends/party/create', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res); if (!gate) return;
    if (!gate.a) return res.redirect('/friends');
    const me = lc(req.userEmail);
    if (!myPersistentParty(me)) {   // one party per person
      const name = String(req.body.name || '').trim().slice(0, 40);
      db.prepare('INSERT INTO parties (name, leader_email) VALUES (?,?)').run(name, me);
      audit(me, 'player', 'party:create', name);
    }
    res.redirect('/friends');
  });
  app.post('/friends/party/invite', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res); if (!gate) return;
    if (!gate.a) return res.redirect('/friends');
    const me = lc(req.userEmail);
    if (rateLimited('party-invite', me, 30, 10 * 60 * 1000)) return res.redirect('/friends');
    const p = stmtPartyLedBy.get(me); if (!p) return res.redirect('/friends');   // the leader invites
    const t = stmtApplicantById.get(Number(req.body.id) || 0);
    if (!t || t.status !== 'approved' || /@guest\.local$/.test(t.email)) return res.redirect('/friends');
    const them = lc(t.email);
    if (them === me || !isFollowing(me, them) || blockedPair(me, them)) return res.redirect('/friends');   // invite people you follow
    if (myPersistentParty(them)) return res.redirect('/friends');                                          // they're committed elsewhere
    const active = persistentPartyActive(p);
    if (active.some(e => e !== them && blockedPair(them, e))) return res.redirect('/friends');             // block invariant
    if (active.length >= partyCap()) return res.redirect('/friends');                                      // size cap
    db.prepare("INSERT OR IGNORE INTO party_members (party_id, email, status) VALUES (?,?,'invited')").run(p.id, them);
    res.redirect('/friends');
  });
  app.post('/friends/party/accept', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res); if (!gate) return;
    if (!gate.a) return res.redirect('/friends');
    const me = lc(req.userEmail), pid = Number(req.body.party) || 0;
    const inv = db.prepare("SELECT 1 FROM party_members WHERE party_id=? AND email=? AND status='invited'").get(pid, me);
    if (!inv || myPersistentParty(me)) return res.redirect('/friends');   // must hold the invite; one party per person
    const row = stmtPartyRow.get(pid); if (!row) return res.redirect('/friends');
    if (persistentPartyActive(row).some(e => e !== me && blockedPair(me, e))) return res.redirect('/friends');   // block invariant
    db.prepare("UPDATE party_members SET status='joined' WHERE party_id=? AND email=?").run(pid, me);
    res.redirect('/friends');
  });
  app.post('/friends/party/decline', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res); if (!gate) return;
    if (!gate.a) return res.redirect('/friends');
    const me = lc(req.userEmail), pid = Number(req.body.party) || 0;
    db.prepare("DELETE FROM party_members WHERE party_id=? AND email=? AND status='invited'").run(pid, me);   // decline = delete → re-invitable
    res.redirect('/friends');
  });
  // Leader revokes an invite / removes a member — otherwise a stale invite pins a party slot
  // forever (P3-3). Leader-only; target resolved server-side from the applicant id.
  app.post('/friends/party/remove', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res); if (!gate) return;
    const me = lc(req.userEmail);
    const p = stmtPartyLedBy.get(me); if (!p) return res.redirect('/friends');
    const t = stmtApplicantById.get(Number(req.body.id) || 0);
    if (t && lc(t.email) !== me) db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(p.id, lc(t.email));
    res.redirect('/friends');
  });
  app.post('/friends/party/leave', requireLogin, (req, res) => {
    const gate = requirePlayer(req, res); if (!gate) return;
    if (!gate.a) return res.redirect('/friends');
    const me = lc(req.userEmail);
    const p = myPersistentParty(me); if (!p) return res.redirect('/friends');
    if (lc(p.leader_email) === me) {   // leader → disband. Already-seated checkins stay (they're in for this week).
      db.prepare('DELETE FROM party_members WHERE party_id=?').run(p.id);
      db.prepare('DELETE FROM parties WHERE id=?').run(p.id);
      audit(me, 'player', 'party:disband', String(p.id));
    } else {
      db.prepare('DELETE FROM party_members WHERE party_id=? AND email=?').run(p.id, me);
    }
    res.redirect('/friends');
  });
}
