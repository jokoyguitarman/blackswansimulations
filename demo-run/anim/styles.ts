/**
 * Stylesheet for the rendered trailer, at 1920x1080 design size.
 *
 * Values are lifted from the product rather than invented: Fakebook's #1877F2
 * and #F0F2F5 chrome, the desktop shell's #1C1C1E windows and traffic lights,
 * the brand's #0E1A2B navy with the #D97706 amber kicker. If a colour here
 * disagrees with the app, the app wins — the whole argument for rendering
 * instead of recording is that it still has to look like the software.
 */

export const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600;700&display=swap');

*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1920px;height:1080px;overflow:hidden;background:#000}
body{font:16px/1.5 Inter,-apple-system,"Segoe UI",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.stage{position:relative;width:1920px;height:1080px;overflow:hidden;background:#000}
img{display:block}
mark.lens{background:#FFF0C2;color:#111;border-radius:3px;padding:0 4px;box-shadow:0 0 0 3px #F0B429}

/* ── Desktop shell ───────────────────────────────────────────────── */
.desk{position:absolute;inset:0;background:#0e1a2b url('/a/icons/wallpaper.jpg') center/cover no-repeat}
.dk-icons{position:absolute;top:34px;left:34px;display:grid;grid-template-columns:repeat(2,120px);
  gap:22px 26px;z-index:2}
.dk-icon{display:flex;flex-direction:column;align-items:center;gap:9px}
.dk-tile{width:74px;height:74px;border-radius:18px;overflow:hidden;background:rgba(30,30,30,.55);
  box-shadow:0 5px 16px rgba(0,0,0,.5)}
.dk-tile img{width:100%;height:100%;object-fit:cover}
.dk-icon span{font-size:16px;color:#fff;text-shadow:0 2px 5px rgba(0,0,0,.9);font-weight:500}

.dk-win{position:absolute;border-radius:14px;overflow:hidden;background:#1C1C1E;
  box-shadow:0 34px 90px rgba(0,0,0,.62),0 0 0 1px rgba(255,255,255,.07);transform-origin:50% 100%}
.dk-titlebar{height:44px;background:#2C2C2E;display:flex;align-items:center;padding:0 16px;gap:12px}
.dk-tb-left img{width:22px;height:22px;border-radius:5px}
.dk-tb-title{flex:1;text-align:center;font-size:15px;color:#D8DCE2;font-weight:600}
.dk-tb-btns{display:flex;gap:9px}
.dk-tb-btns i{width:14px;height:14px;border-radius:50%;display:block}
.dk-tb-btns i.min{background:#FEBC2E}
.dk-tb-btns i.max{background:#28C840}
.dk-tb-btns i.close{background:#FF5F57}
.dk-winbody{position:absolute;inset:44px 0 0;overflow:hidden;background:#F0F2F5}

.dk-taskbar{position:absolute;left:0;right:0;bottom:0;height:52px;background:rgba(10,14,22,.9);
  display:flex;align-items:center;gap:10px;padding:0 20px;z-index:20}
.dk-task{display:inline-flex;align-items:center;gap:9px;font-size:15px;padding:8px 14px;
  border-radius:9px;color:#C3CBD6}
.dk-task img{width:22px;height:22px;border-radius:5px}
.dk-task.open{color:#fff;background:rgba(255,255,255,.15)}
.dk-task.min{background:rgba(255,255,255,.06)}
.dk-clock{margin-left:auto;font-size:15px;color:#9AA7B5;font-variant-numeric:tabular-nums}

/* ── Fakebook ────────────────────────────────────────────────────── */
.fb-app{position:absolute;inset:0;background:#F0F2F5;display:flex;flex-direction:column;
  font-family:"Segoe UI",Helvetica,Arial,sans-serif;color:#050505}
.fb-topbar{height:62px;background:#fff;display:flex;align-items:center;gap:18px;padding:0 20px;
  box-shadow:0 2px 5px rgba(0,0,0,.09);flex-shrink:0;z-index:5}
.fb-logo{font-size:29px;font-weight:800;font-style:italic;color:#1877F2}
.fb-search{flex:0 0 320px;background:#F0F2F5;border-radius:22px;padding:10px 18px;font-size:16px;color:#65676B}
.fb-icons{margin-left:auto;display:flex;align-items:center;gap:16px;font-size:22px}
.fb-me{width:38px;height:38px;border-radius:50%;background:#1877F2;color:#fff;font-size:17px;
  font-weight:700;display:flex;align-items:center;justify-content:center}
.fb-scroll{flex:1;overflow:hidden;padding:18px 0;display:flex;flex-direction:column;align-items:center;gap:16px}
.fb-newpost{width:720px;background:#fff;border-radius:12px;padding:16px 18px;display:flex;
  align-items:center;gap:14px;box-shadow:0 1px 3px rgba(0,0,0,.12);flex-shrink:0}
.fb-newbox{flex:1;background:#F0F2F5;border-radius:22px;padding:12px 18px;color:#65676B;font-size:18px}

.ava{border-radius:50%;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
.fb{width:720px;background:#fff;border-radius:12px;overflow:hidden;flex-shrink:0;
  box-shadow:0 1px 3px rgba(0,0,0,.14)}
.fb-head{display:flex;gap:14px;align-items:center;padding:16px 18px 10px}
.fb-who{flex:1}
.fb-name{font-weight:650;font-size:19px}
.fb-sub{font-size:14.5px;color:#65676B;margin-top:2px}
.fb-more{font-size:26px;color:#65676B;line-height:1;padding:0 6px}
.fb-more.flagged{color:#F59E0B}
.fb-body{padding:2px 18px 14px;font-size:19px;line-height:1.45}
.fb-media{width:100%;max-height:400px;object-fit:cover}
.fb-stats{display:flex;justify-content:space-between;padding:12px 18px;font-size:16px;color:#65676B}
.fb-stats b{font-weight:400;font-variant-numeric:tabular-nums}
.fb-bar{display:flex;border-top:1px solid #CED0D4;padding:4px 10px}
.fb-bar .act{flex:1;text-align:center;padding:11px 0;font-size:17px;font-weight:600;color:#65676B}
.fb-comments{border-top:1px solid #E4E6EB;padding:14px 18px 18px;display:flex;flex-direction:column;gap:12px}
.fb-comment{display:flex;gap:11px}
.fb-bubble{background:#F0F2F5;border-radius:20px;padding:10px 16px;max-width:560px}
.fb-cname{font-weight:650;font-size:16px}
.fb-ctext{font-size:17px;line-height:1.4;margin-top:1px}
.fb-cmeta{font-size:14px;color:#65676B;margin-top:4px}
.fb-composer{display:flex;gap:11px;align-items:flex-start}
.fb-cinput{flex:1;background:#F0F2F5;border-radius:20px;padding:11px 16px;font-size:17px;
  min-height:44px;line-height:1.4}

/* composer */
.cmp{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:760px;background:#fff;
  border-radius:14px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.4)}
.cmp-head{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;
  border-bottom:1px solid #DADDE1}
.cmp-cancel{color:#65676B;font-weight:600;font-size:18px}
.cmp-title{font-weight:700;font-size:21px}
.cmp-post{background:#1877F2;color:#fff;font-weight:700;padding:9px 24px;border-radius:8px;font-size:17px}
.cmp-as{display:flex;gap:10px;align-items:center;padding:12px 20px;background:#F0F2F5;
  border-bottom:1px solid #E4E6EB;font-size:16px}
.cmp-as-label{color:#65676B}
.chip{padding:6px 16px;border-radius:20px;border:1px solid #CED0D4;color:#65676B;font-weight:650}
.chip.on{background:#E7F3FF;border-color:#1877F2;color:#1877F2}
.cmp-body{display:flex;gap:14px;padding:20px}
.cmp-text{flex:1;font-size:21px;line-height:1.55;min-height:190px}
.typed{color:#050505}
.untyped{color:#BCC0C4}
.caret{display:inline-block;width:3px;height:23px;background:#1877F2;vertical-align:-4px;margin:0 2px}
.cmp-attach{width:calc(100% - 40px);margin:0 20px 14px;border-radius:10px;max-height:220px;object-fit:cover}
.cmp-foot{display:flex;gap:24px;padding:14px 20px;border-top:1px solid #DADDE1;font-size:26px}

/* ── Messenger, mirroring FacebookMessengerView ──────────────────── */
.fb-ico{position:relative}
.fb-badge{position:absolute;top:-6px;right:-8px;min-width:22px;height:22px;border-radius:11px;
  background:#F02849;color:#fff;font-size:13px;font-weight:700;font-style:normal;
  display:flex;align-items:center;justify-content:center;padding:0 5px;
  box-shadow:0 0 0 2px #fff}

/* The incoming-message toast: the shell's own banner treatment. */
.fb-toast{position:absolute;right:20px;top:74px;width:400px;background:#fff;border-radius:14px;
  padding:14px 16px;display:flex;align-items:center;gap:13px;z-index:40;
  box-shadow:0 12px 40px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.06)}
.fb-toast-body{flex:1;min-width:0}
.fb-toast-title{font-size:16px;font-weight:700;color:#050505}
.fb-toast-prev{font-size:15px;color:#65676B;margin-top:3px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}

.dm-wrap{flex:1;display:flex;min-height:0;background:#fff}
.dm-list{width:330px;border-right:1px solid #E4E6EB;flex-shrink:0;overflow:hidden}
.dm-list-head{padding:18px 20px 12px;font-size:24px;font-weight:800}
.dm-tabs{display:flex;gap:8px;padding:0 20px 14px}
.dm-tab{font-size:14px;font-weight:650;color:#65676B;background:#F0F2F5;padding:7px 14px;border-radius:18px}
.dm-tab.on{background:#E7F3FF;color:#1877F2}
.dm-thread{display:flex;align-items:center;gap:13px;padding:12px 18px}
.dm-thread.active{background:#E7F3FF}
.dm-thread-txt{flex:1;min-width:0}
.dm-thread-name{font-size:17px;font-weight:650;color:#050505}
.dm-thread-prev{font-size:15px;color:#65676B;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.dm-unread{width:12px;height:12px;border-radius:50%;background:#1877F2;flex-shrink:0}

.dm-conv{flex:1;display:flex;flex-direction:column;min-width:0}
.dm-conv-head{display:flex;align-items:center;gap:13px;padding:14px 22px;border-bottom:1px solid #E4E6EB}
.dm-back{font-size:32px;color:#1877F2;line-height:1;margin-right:2px}
.dm-conv-name{font-size:19px;font-weight:650}
.dm-conv-body{flex:1;padding:22px;display:flex;flex-direction:column;gap:14px;overflow:hidden}
.dm-row{display:flex;justify-content:flex-start}
.dm-row.me{justify-content:flex-end}
.dm-bub{max-width:74%;background:#F0F2F5;color:#050505;padding:12px 16px;border-radius:20px;
  border-bottom-left-radius:5px}
.dm-bub.me{background:#1877F2;color:#fff;border-bottom-left-radius:20px;border-bottom-right-radius:5px}
.dm-text{font-size:19px;line-height:1.42}
.dm-time{font-size:13px;opacity:.62;margin-top:5px}
/* The shared-post card lives inside the bubble, as it does in the app. */
.dm-card{border:1px solid #CED0D4;border-radius:10px;overflow:hidden;margin-bottom:8px;background:#fff}
.dm-card.mine{border-color:rgba(255,255,255,.35);background:rgba(255,255,255,.12)}
.dm-card-img{width:100%;height:190px;object-fit:cover}
.dm-card-txt{padding:11px 13px}
.dm-card-author{font-size:15px;font-weight:650}
.dm-card-prev{font-size:15px;opacity:.85;line-height:1.35;margin-top:3px}
.dm-card-plat{font-size:13px;opacity:.6;margin-top:5px}
.dm-conv-input{margin:0 22px 20px;background:#F0F2F5;border-radius:24px;padding:14px 20px;
  color:#8A94A0;font-size:17px}

/* Page notifications */
.notif{flex:1;background:#fff;overflow:hidden}
.notif-head{padding:20px 26px;font-size:24px;font-weight:800;border-bottom:1px solid #E4E6EB}
.notif-row{display:flex;align-items:center;gap:15px;padding:18px 26px;border-bottom:1px solid #F0F2F5}
.notif-txt{flex:1;font-size:18px;line-height:1.4;color:#050505}
.notif-dot{width:12px;height:12px;border-radius:50%;background:#1877F2;flex-shrink:0}

/* ── News ────────────────────────────────────────────────────────── */
.news-app{position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;
  font-family:Georgia,"Times New Roman",serif;color:#111}
.news-mast{font-family:Inter,sans-serif;font-weight:800;letter-spacing:.16em;font-size:16px;
  color:#C8102E;border-bottom:3px solid #C8102E;padding:20px 40px;flex-shrink:0}
.news-scroll{flex:1;overflow:hidden;padding:26px 40px}
.news-tag{display:inline-block;background:#C8102E;color:#fff;font-family:Inter,sans-serif;
  font-size:13px;font-weight:800;letter-spacing:.14em;padding:6px 12px;border-radius:4px;margin-bottom:18px}
.news-h1{font-size:46px;line-height:1.16;margin-bottom:16px;letter-spacing:-.01em}
.news-h1.struck{text-decoration:line-through;text-decoration-color:rgba(198,40,40,.45);opacity:.6}
.news-sub{font-size:22px;color:#444;line-height:1.45;margin-bottom:26px}
.news-p{font-size:19px;color:#333;line-height:1.72;margin-bottom:18px}
.news-hero{width:100%;max-height:360px;object-fit:cover;border-radius:8px;margin-bottom:24px}

/* Headline wire */
.nl-row{display:flex;gap:22px;padding:22px 0;border-bottom:1px solid #E8E8E8;align-items:flex-start}
.nl-img{width:220px;height:140px;object-fit:cover;border-radius:8px;flex-shrink:0}
.nl-blank{background:linear-gradient(135deg,#E8EAED,#D8DCE1)}
.nl-txt{flex:1;font-family:Georgia,serif}
.nl-tag{display:inline-block;background:#C8102E;color:#fff;font-family:Inter,sans-serif;font-size:11px;
  font-weight:800;letter-spacing:.14em;padding:4px 9px;border-radius:3px;margin-bottom:10px}
.nl-head{font-size:28px;line-height:1.22;color:#111;letter-spacing:-.01em}
.nl-meta{font-family:Inter,sans-serif;font-size:15px;color:#65676B;margin-top:10px}
.news-dispute{display:inline-block;background:#FCE4EC;color:#C62828;font-family:Inter,sans-serif;
  font-size:16px;font-weight:700;padding:12px 22px;border-radius:26px;margin-top:12px}
.retract{background:#FDECEA;border:2px solid #F0556A;border-radius:10px;padding:18px 22px;
  margin-bottom:22px;font-family:Inter,sans-serif}
.retract b{display:block;font-size:20px;color:#C62828}
.retract span{display:block;font-size:16px;color:#8E6B6B;margin-top:6px;line-height:1.5}

/* ── Mail ────────────────────────────────────────────────────────── */
.mail-app{position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;
  font-family:Inter,"Segoe UI",sans-serif;color:#1F2328}
.mail-head{background:#F6F8FA;padding:18px 28px;font-weight:700;font-size:19px;
  border-bottom:1px solid #DADDE1;flex-shrink:0}
.mail-scroll{flex:1;overflow:hidden}
.mail-row{display:flex;gap:16px;align-items:center;padding:20px 28px;border-bottom:1px solid #EEF0F2}
.mail-row.framed{background:#FFF6E0;box-shadow:inset 0 0 0 3px #F0B429}
.dot{width:12px;height:12px;border-radius:50%;background:#1877F2;flex:0 0 12px}
.mail-meta{flex:1;min-width:0}
.mail-from{font-weight:650;font-size:17px}
.mail-subj{font-size:16px;color:#57606A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}
.pri{font-size:12px;font-weight:800;letter-spacing:.09em;padding:5px 11px;border-radius:5px}
.pri.urgent{background:#FDECEA;color:#C0271A}
.pri.high{background:#FFF3E0;color:#B45309}
.pri.normal{background:#EEF0F2;color:#57606A}
.mail-from-line{padding:18px 28px;font-size:16px;color:#57606A;border-bottom:1px solid #EEF0F2}
.mail-body{padding:22px 28px;font-size:18px;line-height:1.75;white-space:normal}
.mail-reply{border-bottom:1px solid #EEF0F2;padding:18px 28px;background:#F8FBFF}
.mail-reply-to{font-size:15px;color:#57606A;margin-bottom:10px}
.mail-reply-body{font-size:18px;line-height:1.7;min-height:150px}
.mail-send{display:inline-block;margin-top:14px;background:#1877F2;color:#fff;font-weight:700;
  padding:10px 30px;border-radius:8px;font-size:17px}

/* ── Chat ────────────────────────────────────────────────────────── */
.chat-app{position:absolute;inset:0;background:#11151B;display:flex;flex-direction:column;
  font-family:Inter,"Segoe UI",sans-serif}
.chat-head{font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:#7C8899;
  padding:20px 26px;border-bottom:1px solid #232A33;flex-shrink:0}
.chat-scroll{flex:1;overflow:hidden;padding:22px 26px;display:flex;flex-direction:column;gap:16px}
.msg{max-width:76%}
.msg.me{align-self:flex-end;text-align:right}
.msg-from{font-size:14px;color:#6B7787;margin-bottom:5px}
.msg-bub{display:inline-block;background:#1C232C;color:#DDE4EC;padding:13px 18px;border-radius:16px;
  text-align:left;font-size:19px;line-height:1.45}
.msg.me .msg-bub{background:#1E4B8F;color:#EAF2FF}
.chat-input{display:flex;align-items:center;gap:14px;padding:18px 26px;border-top:1px solid #232A33}
.chat-field{flex:1;background:#1C232C;border-radius:24px;padding:13px 20px;font-size:18px;
  color:#DDE4EC;min-height:48px}
.chat-send{color:#1877F2;font-size:24px}

/* ── Sheets ──────────────────────────────────────────────────────── */
.sheet{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:620px;background:#000;
  border:1px solid #2F3336;border-radius:20px;padding:26px;color:#E7E9EA;
  font-family:Inter,"Segoe UI",sans-serif;box-shadow:0 30px 80px rgba(0,0,0,.6);z-index:40}
.sheet-head{font-size:26px;font-weight:800;margin-bottom:18px}
.sheet-sub{font-size:15px;color:#71767B;font-weight:600;margin:16px 0 10px}
.opt{border:1px solid #2F3336;border-radius:12px;padding:14px 18px;margin-bottom:9px;font-size:18px;
  display:flex;justify-content:space-between;align-items:center}
.opt.on{border-color:#1D9BF0;background:rgba(29,155,240,.15);color:#1D9BF0;font-weight:650}
.opt b{color:#1D9BF0}
.sheet-text{border:1px solid #2F3336;border-radius:12px;padding:16px;min-height:96px;font-size:17px;line-height:1.55}
.sheet-text.tall{min-height:150px}
.sheet-text .typed{color:#E7E9EA}
.sheet-text .untyped{color:#4A5057}
.sheet-btn{margin-top:20px;background:#F4212E;color:#fff;font-weight:700;text-align:center;
  padding:16px;border-radius:9999px;font-size:19px}
.sheet-ok{margin-top:20px;color:#34C759;font-weight:700;font-size:19px;text-align:center}

/* ── Dashboard ───────────────────────────────────────────────────── */
.dash{position:absolute;inset:0;background:#0E1116;padding:46px 60px;
  font-family:Inter,"Segoe UI",sans-serif;display:flex;flex-direction:column}
.dash-head{display:flex;justify-content:space-between;font-size:16px;letter-spacing:.14em;
  text-transform:uppercase;color:#7C8899;padding-bottom:26px;border-bottom:1px solid #232A33}
.dash-clock{color:#F0B429;font-variant-numeric:tabular-nums}
.dash-hero{text-align:center;padding:34px 0 26px}
.dash-big{font-size:112px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.03em}
.dash-big-lab{font-size:16px;color:#64748b;margin-top:10px;letter-spacing:.1em;text-transform:uppercase}
.gauges{display:grid;grid-template-columns:repeat(4,1fr);gap:34px;margin-bottom:26px}
.g-lab{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#6B7787;margin-bottom:12px}
.g-val{font-size:52px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.g-track{height:9px;background:#1C232C;border-radius:5px;margin-top:16px;overflow:hidden}
.g-fill{height:100%;border-radius:5px}
.spark{width:100%;flex:1;min-height:0}
.dash-alert{background:#2A1618;border:1px solid #5B2126;color:#FF8A8A;font-size:17px;font-weight:800;
  letter-spacing:.1em;padding:16px 22px;border-radius:9px;text-align:center}

/* ── Graphics ────────────────────────────────────────────────────── */
.mosaic{position:absolute;inset:0;background:#07090C;display:grid;grid-template-columns:repeat(5,1fr);
  grid-template-rows:repeat(5,1fr);gap:10px;padding:60px}
.tile{border-radius:7px;background:linear-gradient(150deg,#16202D,#22303F)}

.endcard{position:absolute;inset:0;background:#0E1A2B;display:flex;flex-direction:column;
  align-items:center;justify-content:center;overflow:hidden;font-family:Inter,sans-serif}
.endcard::before{content:'';position:absolute;inset:0;
  background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:64px 64px}
.endcard::after{content:'';position:absolute;top:-40%;left:50%;width:70%;height:90%;
  transform:translateX(-50%);
  background:radial-gradient(ellipse at center,rgba(217,119,6,.18),transparent 70%)}
.ec-logo{position:relative;z-index:2;width:92px;height:92px;border-radius:9999px;background:#fff;
  display:flex;align-items:center;justify-content:center;margin-bottom:30px}
.ec-logo img{width:66px;height:66px;object-fit:contain}
.ec-kicker{position:relative;z-index:2;font-family:"JetBrains Mono",monospace;font-size:19px;
  text-transform:uppercase;letter-spacing:.18em;color:#D97706;font-weight:600;margin-bottom:26px}
.ec-line{position:relative;z-index:2;font-size:84px;font-weight:800;letter-spacing:-.028em;
  color:#fff;line-height:1.08}
.ec-sub{position:relative;z-index:2;font-size:21px;color:rgba(255,255,255,.55);margin-top:30px;
  max-width:660px;text-align:center;line-height:1.6}

/* ── Phone shell ─────────────────────────────────────────────────────
   Backdrop is the marketing site's own treatment, so the trailer and the
   landing page read as one piece of work: a hero photograph dimmed hard, the
   .deep-grid 64px lattice over it, and the amber top-glow. The phone sits left
   of centre with a live stats panel to its right, which fixes the dead margins
   a portrait device leaves in a landscape frame. */
.phone-stage{position:absolute;inset:0;background:#0a0f18;overflow:hidden}
.phone-stage::before{content:'';position:absolute;inset:0;
  background-image:
    radial-gradient(ellipse 80% 60% at 50% -10%, rgba(217,119,6,.17), transparent 70%),
    linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px),
    linear-gradient(160deg, rgba(11,20,34,.955) 0%, rgba(18,33,52,.935) 55%, rgba(20,40,66,.955) 100%),
    var(--bgimg, none);
  background-size:100% 100%,64px 64px,64px 64px,100% 100%,cover;
  background-position:center,center,center,center,center}
.phone-stage::after{content:'';position:absolute;inset:0;
  background:radial-gradient(ellipse 78% 84% at 42% 50%, transparent 44%, rgba(4,7,12,.72) 100%)}
/* 980, not 1040: at full frame height the rounded corners clip against the top
   and bottom edges and the device stops reading as a whole object. */
.phone{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:484px;height:980px;
  background:#000;border-radius:56px;padding:13px;z-index:2;
  box-shadow:0 50px 120px rgba(0,0,0,.8),0 0 0 3px #2a2f3a,0 0 90px rgba(24,119,242,.10)}
.phone-stage.with-side .phone{left:38%}
.phone-notch{position:absolute;left:50%;top:13px;transform:translateX(-50%);width:176px;height:31px;
  background:#000;border-radius:0 0 20px 20px;z-index:30}

/* The stats panel beside the handset. Deliberately a broadcast overlay rather
   than a screenshot of the dashboard — it is commentary on the phone, not a
   second interface competing with it. */
/* Sits just off the phone's right edge rather than hugging the frame border:
   the numbers are commentary on the screen beside them, and pushing them to
   the far right made them read as an unrelated overlay. */
.side{position:absolute;left:57%;top:50%;transform:translateY(-50%);width:440px;z-index:3;
  font-family:Inter,sans-serif}
.side-kicker{font-family:"JetBrains Mono",monospace;font-size:15px;text-transform:uppercase;
  letter-spacing:.18em;color:#D97706;font-weight:600;margin-bottom:30px}
.side-g{margin-bottom:26px}
.side-g-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.side-g-lab{font-size:16px;color:rgba(255,255,255,.62);letter-spacing:.04em}
.side-g-val{font-size:42px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.side-g-track{height:7px;background:rgba(255,255,255,.12);border-radius:4px;overflow:hidden}
.side-g-fill{height:100%;border-radius:4px}
.side-spark{width:100%;height:130px;display:block;margin-top:18px}
.side-cap{font-size:16px;color:rgba(255,255,255,.5);margin-top:14px;line-height:1.5}

/* ── Organisation page, mirroring OrgPageView ────────────────────── */
.page-scroll{position:absolute;inset:0;overflow:hidden;background:#F0F2F5;
  font-family:"Segoe UI",Helvetica,sans-serif;color:#050505}
.page-head{background:#fff;padding-bottom:0}
.page-cover{height:230px;background:linear-gradient(135deg,#1877F2 0%,#0B7A4B 100%)}
.page-id{display:flex;gap:22px;padding:0 40px;margin-top:-56px;align-items:flex-end}
.page-logo{width:130px;height:130px;border-radius:16px;background:#0B7A4B;color:#fff;
  font-size:58px;font-weight:800;display:flex;align-items:center;justify-content:center;
  border:5px solid #fff;flex-shrink:0}
.page-logo.sm{width:52px;height:52px;border-radius:9px;font-size:24px;border:0}
.page-meta{padding-bottom:14px}
.page-name{font-size:34px;font-weight:800;letter-spacing:-.01em}
.page-tick{color:#1877F2;font-size:26px}
.page-handle{font-size:17px;color:#65676B;margin-top:5px}
.page-bio{font-size:17px;color:#3A3B3C;margin-top:9px;max-width:820px}
.page-tabs{display:flex;gap:34px;padding:22px 40px 0;border-top:1px solid #E4E6EB;margin-top:20px}
.page-tabs span{font-size:17px;font-weight:600;color:#65676B;padding-bottom:14px}
.page-tabs span.on{color:#1877F2;box-shadow:inset 0 -3px 0 #1877F2}
.page-compose{background:#fff;margin:16px auto 0;width:860px;border-radius:12px;padding:18px 20px;
  box-shadow:0 1px 3px rgba(0,0,0,.13)}
.page-compose-head{display:flex;align-items:center;gap:13px;font-size:16px;color:#65676B;
  margin-bottom:14px}
.page-compose-box{min-height:120px;font-size:20px;line-height:1.5}
.page-compose-foot{display:flex;justify-content:flex-end;border-top:1px solid #E4E6EB;
  padding-top:14px;margin-top:12px}
.page-post-btn{background:#1877F2;color:#fff;font-weight:700;padding:10px 30px;border-radius:8px;
  font-size:17px}
.page-post{background:#fff;margin:16px auto 0;width:860px;border-radius:12px;overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.13)}
.page-post-head{display:flex;align-items:center;gap:13px;padding:16px 20px 10px}
.page-post-name{font-size:18px;font-weight:650}
.page-post-time{font-size:14.5px;color:#65676B;margin-top:2px}
.page-post-body{padding:2px 20px 14px;font-size:18px;line-height:1.45}
.page-post-img{width:100%;max-height:330px;object-fit:cover}
.page-post-stats{padding:12px 20px;font-size:16px;color:#65676B;border-top:1px solid #E4E6EB}

/* Full-frame brand wipe for shell transitions. */
.wipe{position:absolute;inset:0;z-index:900;opacity:0;pointer-events:none;
  background-image:
    radial-gradient(ellipse 80% 60% at 50% -10%, rgba(217,119,6,.20), transparent 70%),
    linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px),
    linear-gradient(160deg,#0e1a2b 0%,#16293f 55%,#18304e 100%);
  background-size:100% 100%,64px 64px,64px 64px,100% 100%}
.phone-screen{position:relative;width:100%;height:100%;border-radius:44px;overflow:hidden;background:#F0F2F5}
.phone-screen .fb-app,.phone-screen .news-app,.phone-screen .page-scroll{position:absolute;inset:0}
.phone-screen .fb{width:100%;border-radius:0;box-shadow:none}
.phone-screen .fb-scroll{padding:10px 0;gap:10px}
.phone-screen .fb-search{display:none}
.phone-screen .fb-topbar{padding:0 14px;gap:10px}
`;
