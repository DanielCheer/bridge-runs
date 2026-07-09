**⚠️ DRAFT — not legal advice. Have a qualified Ontario lawyer review and adapt before use.**

# Software Handover Agreement (Template) — The Bridge Adv Runs

*Draft version. This template offers TWO alternative commercial options (A and B). Choose ONE, delete the other, and fill in every [bracketed blank] before signing. Have a lawyer review.*

---

## Parties

This Agreement is made on **[DATE]** between:

- **[DEVELOPER FULL NAME]** ("the Developer"), of **[ADDRESS]**; and
- **The Bridge church** ("the Church"), of **[ADDRESS]**, represented by **[NAME, TITLE]**.

Together, the "Parties."

---

## Background

The Developer built and currently owns and operates a Progressive Web App called **"The Bridge Adv Runs"** (the "App") for a weekly recreational basketball run associated with the Church. The App handles player sign-in, check-ins for limited floor spots and a waitlist, group and 1:1 chat, announcements, player profiles, roles and approvals, attendance history, and invites/QR codes. It runs on Node.js with a SQLite database.

The Church wishes to take over the App. The Parties agree to one of the two options below.

---

## 1. Choose your option

> **Select ONE. Delete the option you are not using.**

### ── OPTION A — One-Time Buyout ──

1.1 **Purchase price.** The Church will pay the Developer a one-time lump sum of **$[AMOUNT] [CAD]**, payable **[on signing / on completion of handover / per schedule: __________]**.

1.2 **IP assignment.** On full payment, the Developer **assigns all intellectual property and copyright** in the App — including the source code, database schema, and design — to the Church. The Developer will sign any reasonable further documents needed to complete this transfer.

1.3 **Transition support.** The Developer will provide transition support for **[NUMBER] [days/weeks]** after handover, up to about **[NUMBER] hours**, to help the Church get the App running on its own systems and answer reasonable questions. Support beyond this is by separate agreement.

1.4 **Hosting and data custody transfer.** On handover, the Church will host the App on its own infrastructure and becomes responsible for hosting, security, backups, and custody of all user data. The Developer will stop hosting the App and, after a short agreed overlap, will securely delete its copies of the production data (except any minimal records needed for legal or accounting reasons).

### ── OPTION B — Ongoing Maintenance ──

1.1 **Ownership stays with the Developer.** The Developer keeps ownership of the App and its intellectual property, and grants the Church a **non-exclusive, non-transferable licence** to use and operate the App for the run for as long as this Agreement is in effect.

1.2 **Monthly fee.** The Church will pay the Developer **$[AMOUNT] [CAD] per month**, payable **[in advance / in arrears]** on **[DAY]** of each month.

1.3 **What's included.** For the monthly fee, the Developer will provide: reasonable **maintenance**, **bug fixes**, **security updates**, minor **updates/improvements**, and **light support** (see Section 5).

1.4 **What's excluded.** The fee does **not** include: major new features, redesigns, migrations to new platforms, third-party costs (e.g., email or hosting fees), or support caused by the Church's own changes or misuse. These are quoted separately.

1.5 **Term and termination.** This Agreement runs on a **[month-to-month / [NUMBER]-month]** term. Either Party may end it with **[NUMBER] days'** written notice. Fees already paid are **[non-refundable / pro-rated]**.

1.6 **Hosting and data custody.** The Church hosts the App on its own infrastructure and is the custodian of all user data. The Developer maintains the software but is not responsible for the Church's hosting, backups, or data security beyond delivering working, reasonably secure code.

---

## 2. What is delivered (both options)

On handover, the Developer will provide:

- The **source code** of the App.
- The **database schema** and a **full export of the current data** in a usable format.
- Basic **setup/run instructions** so the Church can host it.
- A list of **third-party services** the App depends on (for example, the email delivery provider) and any configuration needed.

---

## 3. Data protection on handover (both options)

3.1 The App holds personal information including names, emails, phone numbers, optional photos, chat messages, and attendance records.

3.2 Once the Church hosts the App, the **Church becomes the data custodian** and is responsible for complying with applicable privacy law (including PIPEDA and Ontario requirements), for securing the data, honouring user access/correction/deletion requests, retention limits, and breach handling.

3.3 The Developer will hand over data securely and, after the agreed overlap, will not retain user data beyond what is needed for legal or accounting reasons.

3.4 **Minors.** The App may hold information about youth players. The Church is responsible for how parental/guardian consent is handled once it operates the App.

> **TODO — resolve before signing:** confirm each Party's privacy responsibilities in writing, and how minors' consent is managed.

---

## 4. Intellectual property summary

- **Option A:** IP transfers to the Church on full payment.
- **Option B:** IP stays with the Developer; the Church gets a licence to use it while the Agreement is active.

Any open-source components remain under their own licences, which continue to apply either way.

---

## 5. Support expectations / light SLA

*(Applies mainly to Option B, or during Option A's transition window.)*

- **Response target:** the Developer aims to respond to support requests within **[NUMBER] business days**.
- **Serious issues** (App down, sign-in broken, data at risk): the Developer aims to respond within **[NUMBER] business day(s)** and work toward a fix on a best-effort basis.
- Support is provided during reasonable hours and does not guarantee 24/7 availability. This is a light, best-effort arrangement, not an enterprise SLA.

---

## 6. Warranties and disclaimer

6.1 The Developer warrants that they have the right to enter this Agreement and (for Option A) to assign the IP, and that the App is their original work except for standard open-source components.

6.2 Otherwise, the App is provided **"as is."** The Developer does not warrant that it is error-free, uninterrupted, or fit for every purpose. All other warranties are excluded to the fullest extent allowed by law.

---

## 7. Limitation of liability

To the fullest extent allowed by Ontario law, neither Party is liable to the other for indirect, incidental, or consequential losses. The Developer's total liability under this Agreement is capped at **[the amounts paid by the Church under this Agreement in the [NUMBER] months before the claim / $[AMOUNT]]**. Nothing in this section limits liability that cannot be limited by law.

---

## 8. Confidentiality

Each Party will keep the other's confidential information (including user data, source code, and business details) private, use it only for this Agreement, and protect it reasonably. This continues after the Agreement ends. It does not apply to information that is public through no fault of the receiving Party or that must be disclosed by law.

---

## 9. Termination and its effects

- **Option A:** the Agreement completes on payment, IP assignment, and handover; confidentiality and data obligations survive.
- **Option B:** on termination, the Church stops using the App unless the Parties agree otherwise, pays any fees owed, and the Parties cooperate on an orderly wind-down. The Developer may keep the software; the Church keeps its own user data it is custodian of.

---

## 10. General

- **Entire agreement:** this document is the whole agreement between the Parties on this subject and replaces earlier discussions.
- **Changes:** any change must be in writing and signed by both Parties.
- **Governing law:** the laws of Ontario and the federal laws of Canada that apply there. Disputes go to the courts of Ontario.
- **Assignment:** neither Party may transfer this Agreement without the other's written consent (except as part of the IP transfer under Option A).

---

## Signatures

**The Developer**

Signature: _______________________  Date: ____________

Name: **[DEVELOPER FULL NAME]**

<br>

**The Church**

Signature: _______________________  Date: ____________

Name: **[NAME]**   Title: **[TITLE]**

On behalf of **The Bridge church**

---

> **Reminder:** This is a rough template with blanks. A qualified Ontario lawyer must review and adapt it — especially the IP assignment wording, liability cap, privacy responsibilities, and minors' consent — before either Party signs.
