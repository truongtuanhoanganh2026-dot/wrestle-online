const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const PORT = Number(process.env.PORT) || 10000;

app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const WORLD = { width: 1280, height: 720, floorY: 570 };
const MAX_ROOMS = 2000;
const PLAYER_RADIUS = 28;
const MAX_HP = 100;

function uid() { return crypto.randomBytes(5).toString('hex'); }
function safeCode(code) { return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
function makeRoom(code) {
  return {
    code,
    createdAt: Date.now(),
    lastTick: Date.now(),
    started: false,
    round: 1,
    players: new Map(),
    winner: null,
  };
}
function publicState(room) {
  const players = {};
  for (const [id, p] of room.players) {
    players[id] = {
      id, x: p.x, y: p.y, vx: p.vx, vy: p.vy, hp: p.hp,
      facing: p.facing, action: p.action, actionT: p.actionT,
      hitFlash: p.hitFlash, color: p.color, name: p.name,
      grounded: p.grounded, blocking: p.blocking, stunned: p.stunned,
    };
  }
  return { type: 'state', world: WORLD, players, started: room.started, winner: room.winner, round: room.round };
}
function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}
function broadcast(room, data) {
  const msg = JSON.stringify(data);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
}
function spawnX(index) { return index === 0 ? 340 : 940; }
function resetPlayer(p, index) {
  p.x = spawnX(index); p.y = WORLD.floorY - 60;
  p.vx = 0; p.vy = 0; p.hp = MAX_HP;
  p.facing = index === 0 ? 1 : -1;
  p.action = 'idle'; p.actionT = 0; p.cooldown = 0;
  p.hitFlash = 0; p.stunned = 0; p.blocking = false; p.grounded = true;
}
function addPlayer(room, ws, name) {
  const index = room.players.size;
  const id = uid();
  const p = {
    id, ws, index, x:0,y:0,vx:0,vy:0,hp:MAX_HP,facing:index===0?1:-1,
    action:'idle',actionT:0,cooldown:0,hitFlash:0,stunned:0,blocking:false,grounded:true,
    input:{left:false,right:false,up:false,down:false,punch:false,kick:false,grapple:false},
    color:index===0?'#45d6ff':'#ff6688', name:(String(name||`Fighter ${index+1}`).slice(0,16)||`Fighter ${index+1}`)
  };
  resetPlayer(p,index);
  room.players.set(id,p);
  ws.roomCode = room.code; ws.playerId = id;
  return p;
}
function distance(a,b){ return Math.hypot(a.x-b.x,a.y-b.y); }
function opponentOf(room, p){ for(const q of room.players.values()) if(q.id!==p.id) return q; return null; }
function tryAttack(room,p,type){
  if(p.cooldown>0 || p.stunned>0 || !p.grounded) return;
  p.action = type; p.actionT = type==='punch'?0.28:type==='kick'?0.38:0.62;
  p.cooldown = p.actionT + 0.18;
  const q=opponentOf(room,p); if(!q) return;
  const reach = type==='punch'?92:type==='kick'?112:78;
  const vertical = Math.abs((p.y-20)-(q.y-20));
  const inFront = (q.x-p.x)*p.facing > -22;
  if(distance(p,q) <= reach && vertical < 100 && inFront){
    let dmg = type==='punch'?8:type==='kick'?13:18;
    if(q.blocking) dmg = Math.max(1, Math.round(dmg*0.28));
    q.hp = Math.max(0, q.hp-dmg); q.hitFlash=0.14;
    const force=type==='punch'?260:type==='kick'?410:520;
    q.vx += p.facing*force/60; q.vy -= type==='grapple'?160:55;
    q.stunned = type==='grapple'?0.45:0.18;
    if(type==='grapple'){ p.action='throw'; p.actionT=0.7; q.action='thrown'; q.actionT=0.7; }
    if(q.hp<=0){ room.winner=p.id; room.started=false; broadcast(room,{type:'ko',winner:p.id}); }
  }
}
function stepPlayer(room,p,dt){
  if(p.cooldown>0) p.cooldown=Math.max(0,p.cooldown-dt);
  if(p.actionT>0) p.actionT=Math.max(0,p.actionT-dt); else if(p.action==='throw'||p.action==='thrown') p.action='idle';
  if(p.hitFlash>0) p.hitFlash=Math.max(0,p.hitFlash-dt);
  if(p.stunned>0) p.stunned=Math.max(0,p.stunned-dt);

  const i=p.input;
  p.blocking=!!(i.down && p.grounded && p.stunned<=0 && p.actionT<=0);
  if(p.stunned>0){ p.vx*=0.93; }
  else if(!p.blocking){
    const accel=1800;
    if(i.left) p.vx-=accel*dt;
    if(i.right) p.vx+=accel*dt;
    if(!i.left && !i.right) p.vx*=Math.pow(0.001,dt);
    p.vx=Math.max(-430,Math.min(430,p.vx));
    if(i.up && p.grounded && p.actionT<=0){p.vy=-760;p.grounded=false;}
    if(i.punch) { i.punch=false; tryAttack(room,p,'punch'); }
    if(i.kick) { i.kick=false; tryAttack(room,p,'kick'); }
    if(i.grapple) { i.grapple=false; tryAttack(room,p,'grapple'); }
  }
  p.vy += 1900*dt;
  p.x += p.vx*dt; p.y += p.vy*dt;
  const minX=40,maxX=WORLD.width-40;
  if(p.x<minX){p.x=minX;p.vx=0}
  if(p.x>maxX){p.x=maxX;p.vx=0}
  const ground=WORLD.floorY-60;
  if(p.y>=ground){p.y=ground;p.vy=0;p.grounded=true}else p.grounded=false;

  if(p.actionT<=0 && p.stunned<=0 && !p.blocking && Math.abs(p.vx)>30) p.action='run';
  else if(p.actionT<=0 && p.stunned<=0 && !p.blocking) p.action='idle';
  else if(p.blocking) p.action='block';
}
function tick(room){
  const now=Date.now();
  let dt=Math.min(0.04,(now-room.lastTick)/1000); room.lastTick=now;
  if(room.players.size===2 && room.started){
    for(const p of room.players.values()) stepPlayer(room,p,dt);
    // light separation to prevent clipping through each other
    const arr=[...room.players.values()]; const a=arr[0],b=arr[1];
    if(a&&b){
      const dx=b.x-a.x, minDist=PLAYER_RADIUS*2+22;
      if(Math.abs(dx)<minDist && Math.abs(dx)>0){ const push=(minDist-Math.abs(dx))/2; const s=Math.sign(dx); a.x-=s*push; b.x+=s*push; a.vx*=0.75; b.vx*=0.75; }
      a.facing = (b.x>a.x)?1:-1; b.facing=(a.x>b.x)?1:-1;
    }
  }
  broadcast(room, publicState(room));
}

wss.on('connection',(ws)=>{
  ws.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw.toString())}catch{return}
    if(msg.type==='join'){
      const code=safeCode(msg.room) || crypto.randomBytes(3).toString('hex').toUpperCase();
      if(rooms.size>=MAX_ROOMS && !rooms.has(code)){send(ws,{type:'error',message:'Máy chủ đang có quá nhiều phòng.'});return}
      let room=rooms.get(code); if(!room){room=makeRoom(code);rooms.set(code)}
      if(room.players.size>=2){send(ws,{type:'error',message:'Phòng đã đủ 2 người.'});return}
      const p=addPlayer(room,ws,msg.name);
      send(ws,{type:'joined',id:p.id,room:room.code,index:p.index});
      broadcast(room,{type:'players',count:room.players.size});
      if(room.players.size===2){ room.started=true; room.winner=null; room.round++; for(const q of room.players.values()) resetPlayer(q,q.index); broadcast(room,{type:'start',room:room.code}); }
      else broadcast(room,{type:'waiting',message:'Đang chờ người chơi thứ 2…',room:room.code});
      return;
    }
    if(!ws.playerId || !ws.roomCode) return;
    const room=rooms.get(ws.roomCode); if(!room) return; const p=room.players.get(ws.playerId); if(!p) return;
    if(msg.type==='input'){
      const keys=msg.keys||{};
      p.input.left=!!keys.left;p.input.right=!!keys.right;p.input.up=!!keys.up;p.input.down=!!keys.down;
      if(keys.punch) p.input.punch=true; if(keys.kick) p.input.kick=true; if(keys.grapple) p.input.grapple=true;
    }
    if(msg.type==='restart' && room.players.size===2){ room.winner=null;room.started=true;room.round++;for(const q of room.players.values())resetPlayer(q,q.index);broadcast(room,{type:'start',room:room.code}); }
    if(msg.type==='leave'){ ws.close(); }
  });
  ws.on('close',()=>{
    const code=ws.roomCode; const room=code&&rooms.get(code); if(!room)return;
    room.players.delete(ws.playerId);
    room.started=false; room.winner=null;
    if(room.players.size===0) rooms.delete(code); else broadcast(room,{type:'waiting',message:'Đối thủ đã rời phòng.',room:room.code});
  });
});

setInterval(()=>{
  for(const room of rooms.values()) tick(room);
},16);

server.listen(PORT,'0.0.0.0',()=>console.log(`Wrestle Arena listening on ${PORT}`));
