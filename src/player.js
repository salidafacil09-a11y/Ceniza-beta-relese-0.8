(function (G) {
  'use strict';

  const U = G.Util;
  // Velocidades (m/s)
  const WALK = 2.1, RUN = 4.3, AIM_WALK = 1.35, AIM_RUN = 3.3, CROUCH_WALK = 1.1, PRONE_WALK = 0.5;
  const ACCEL = 11, DECEL = 14;   // inercia del movimiento omnidireccional
  const RADIUS = 0.28;
  const NOISE_RUN = 7;            // los zombis te oyen correr a esta distancia
  const NOISE_WALK = 2;           // caminando de pie solo te oyen muy de cerca (agachado o tumbado, nada)

  class Player {
    constructor(scene) {
      this.model = G.Models.createHumanoid({
        skin: 0xd6a57e, shirt: 0x3d6a74, pants: 0x34405a, hair: 0x3a2a1c, shoes: 0x3b3029, longSleeves: true
      });
      scene.add(this.model.root);
      this.reset();
    }

    reset() {
      const s = G.World.SPAWN;
      this.pos = { x: s.x, z: s.z };
      this.vel = { x: 0, z: 0 };
      this.y = G.World.groundY(s.x, s.z);
      this.facing = Math.PI;
      this.health = 100;
      this.stamina = 1;
      this.noise = 0;
      this.noiseLevel = 0;
      this.hurt = 0;
      this.phase = 0;
      this.moveAmt = 0;
      this.moveRel = 0;          // dirección del movimiento respecto a donde mira el cuerpo
      this.running = false;
      this.aiming = false;
      this.stance = 'stand';     // stand | crouch | prone
      this.crouchAmt = 0;
      this.proneAmt = 0;
      this.hop = null;
      this.action = null;
      this.climb = null;
      this.weapons = [];         // [{ id, cond, two }]
      this.cur = -1;             // -1 = manos
      this.bleed = 0;
      this.bleedRate = 0;
      this.infected = false;
      this.infectTime = 0;
      this.sick = false;
      this.wounds = 0;
      this.dead = false;
      this.deathCause = '';
      this.model.root.visible = true;
      this.model.body.rotation.set(0, 0, 0);
      this.model.body.position.set(0, 0, 0);
      G.Models.setWeapon(this.model, null);
      G.Models.setBackWeapon(this.model, null);
      this.apply();
    }

    get weapon() { return this.cur >= 0 ? G.Weapons.get(this.weapons[this.cur].id) : G.Weapons.FISTS; }
    get slot() { return this.cur >= 0 ? this.weapons[this.cur] : null; }
    get crouching() { return this.stance === 'crouch'; }
    get prone() { return this.stance === 'prone'; }
    // 0 de pie, 1 agachado, 2 tumbado: cuanto más alto, más difícil que te vean
    get stealth() { return this.stance === 'prone' ? 2 : (this.stance === 'crouch' ? 1 : 0); }

    busy() { return !!(this.action || this.climb); }

    // Agachado o tumbado, los ruidos que haces (puertas, golpes) llegan menos lejos
    get noiseMul() { return this.stance === 'prone' ? 0.35 : (this.stance === 'crouch' ? 0.5 : 1); }

    setStance(s) {
      if (this.dead || this.climb) return;
      this.stance = s;
      if (s === 'prone') G.Input.setAim && G.Input.setAim(false);
    }
    toggleCrouch() { this.setStance(this.stance === 'crouch' ? 'stand' : 'crouch'); }
    toggleProne() { this.setStance(this.stance === 'prone' ? 'stand' : 'prone'); }

    // ---------- Armas ----------
    // Largas: máximo 2 (una en las manos y otra a la espalda). Cortas: en los bolsillos.
    isLongSlot(s) { return !!s && G.Weapons.isLong(G.Weapons.get(s.id)); }
    longCount() { return this.weapons.filter((s) => this.isLongSlot(s)).length; }
    longIndices() { const out = []; this.weapons.forEach((s, i) => { if (this.isLongSlot(s)) out.push(i); }); return out; }
    shortIndices() { const out = []; this.weapons.forEach((s, i) => { if (!this.isLongSlot(s)) out.push(i); }); return out; }

    // ¿Se puede tener en las manos el arma i (o las manos vacías con -1)?
    canHold(i) {
      const held = i >= 0 && this.isLongSlot(this.weapons[i]) ? 1 : 0;
      return this.longCount() - held <= 1;      // a la espalda solo cabe una larga
    }

    get backSlot() { return this.weapons.find((s, i) => i !== this.cur && this.isLongSlot(s)) || null; }
    get pockets() { return this.weapons.filter((s, i) => i !== this.cur && !this.isLongSlot(s)).length; }
    get twoHanded() { const s = this.slot; return !!(s && s.two); }

    refreshModel() {
      G.Models.setWeapon(this.model, this.cur >= 0 ? this.weapons[this.cur].id : null);
      const back = this.backSlot;
      G.Models.setBackWeapon(this.model, back ? back.id : null);
    }

    equip(i) { this.cur = i; this.refreshModel(); }

    // Recuadros del HUD: 1 y 2 = armas largas, 3 = pasar por las cortas
    selectSlot(n) {
      if (this.busy()) return null;
      let target;
      if (n === 3) {
        // pasa a la siguiente arma corta; después de la última, manos libres
        const shorts = this.shortIndices();
        if (!shorts.length) return 'No llevas armas cortas';
        const k = shorts.indexOf(this.cur);
        target = k < 0 ? shorts[0] : (k + 1 < shorts.length ? shorts[k + 1] : -1);
      } else {
        const longs = this.longIndices();
        target = longs[n - 1];
        if (target == null) return null;
        if (target === this.cur) target = -1;         // tocar el arma que tienes la guarda
      }
      if (!this.canHold(target)) return 'Con dos armas largas no tienes manos libres: suelta una';
      this.equip(target);
      return target >= 0 ? 'En las manos: ' + this.weapon.name : 'Manos libres';
    }

    cycleWeapon() {
      if (this.busy() || !this.weapons.length) return null;
      const n = this.weapons.length;
      let i = this.cur, skipped = false;
      for (let k = 0; k <= n; k++) {
        i = i + 1 >= n ? -1 : i + 1;
        if (i === this.cur) break;
        if (this.canHold(i)) { this.equip(i); return 'En las manos: ' + this.weapon.name; }
        skipped = true;
      }
      return skipped ? 'Con dos armas largas no tienes manos libres: suelta una' : null;
    }

    // Devuelve { dropped, equipped }
    pickUp(id, cond) {
      const w = G.Weapons.get(id);
      const slot = { id, cond, two: w.hands === 2 };
      let dropped = null;
      if (G.Weapons.isLong(w) && this.longCount() >= 2) {
        const i = this.isLongSlot(this.slot) ? this.cur : this.weapons.indexOf(this.backSlot);
        dropped = this.weapons[i];
        this.weapons.splice(i, 1);
        if (i === this.cur) this.cur = -1;
        else if (i < this.cur) this.cur--;
      }
      this.weapons.push(slot);
      const ni = this.weapons.length - 1;
      let equipped = false;
      // una larga siempre va a las manos (la anterior pasa a la espalda); una corta, si hay manos libres
      if (G.Weapons.isLong(w) || this.canHold(ni)) { this.cur = ni; equipped = true; }
      this.refreshModel();
      return { dropped, equipped };
    }

    dropCurrent() {
      if (this.cur < 0 || this.busy()) return null;
      const s = this.weapons[this.cur];
      this.weapons.splice(this.cur, 1);
      this.cur = -1;
      this.refreshModel();
      return s;
    }

    toggleGrip() {
      const s = this.slot;
      if (!s || this.busy()) return null;
      s.two = !s.two;
      return (s.two ? 'A dos manos: ' : 'A una mano: ') + this.weapon.name;
    }

    breakCurrent() {
      if (this.cur < 0) return;
      this.weapons.splice(this.cur, 1);
      this.equip(-1);
    }

    // ---------- Daño ----------
    damage(amount) {
      this.health = Math.max(0, this.health - amount);
      this.hurt = 0.4;
    }

    wound(type) {
      this.wounds++;
      if (type === 'rasguño') { this.damage(4); if (Math.random() < 0.07) this.infect(); }
      else if (type === 'laceración') { this.damage(9); this.bleed = Math.max(this.bleed, 12); this.bleedRate = Math.max(this.bleedRate, 0.45); if (Math.random() < 0.25) this.infect(); }
      else { this.damage(14); this.bleed = Math.max(this.bleed, 20); this.bleedRate = Math.max(this.bleedRate, 0.75); this.infect(); }
    }

    infect() { if (!this.infected) { this.infected = true; this.infectTime = 0; } }

    // Saltito (botón Saltar cuando no hay nada que trepar)
    jump() {
      if (this.busy() || this.hop || this.dead) return;
      if (this.stance !== 'stand') { this.setStance('stand'); return; }
      this.hop = { t: 0 };
    }

    // ---------- Actualización ----------
    update(dt, input, cam) {
      if (this.dead) return;
      const f = cam.forward(), r = cam.right();
      const mx = input.move.x, my = input.move.y;
      const mag = Math.min(1, Math.hypot(mx, my));
      const wantsMove = mag > 0.12 && !this.climb && !(this.action && this.action.kind === 'finisher');

      if (input.crouch) this.toggleCrouch();
      if (input.prone) this.toggleProne();
      if (this.prone && this.aiming) this.aiming = false;
      this.aiming = !!input.aim && !this.climb && !this.prone;

      // correr te levanta (también del suelo)
      if (wantsMove && input.run && this.stance !== 'stand' && this.stamina > 0.1) this.stance = 'stand';
      const canRun = this.stamina > 0.04 && !this.action && this.stance === 'stand' && this.proneAmt < 0.2;
      this.running = wantsMove && input.run && canRun;

      // dirección en el mundo relativa a la cámara (en cualquier dirección: omni)
      let wx = f.x * -my + r.x * mx;
      let wz = f.z * -my + r.z * mx;
      const wl = Math.hypot(wx, wz) || 1;
      wx /= wl; wz /= wl;

      let speed;
      if (this.prone || this.proneAmt > 0.5) speed = PRONE_WALK;
      else if (this.running) speed = this.aiming ? AIM_RUN : RUN;
      else if (this.aiming) speed = AIM_WALK;
      else if (this.crouching) speed = CROUCH_WALK;
      else speed = WALK;
      if (this.action) speed *= (this.action.kind === 'stomp' || this.action.kind === 'floor') ? 0.1 : 0.35;
      speed *= wantsMove ? mag : 0;

      // inercia: acelera y frena en unas décimas de segundo
      const tvx = wx * speed, tvz = wz * speed;
      const k = 1 - Math.exp(-dt * (speed > 0.01 ? ACCEL : DECEL));
      this.vel.x += (tvx - this.vel.x) * k;
      this.vel.z += (tvz - this.vel.z) * k;

      if (this.climb) {
        this.updateClimb(dt);
        this.vel.x = this.vel.z = 0;
      } else if (this.action && this.action.kind === 'finisher' && this.action.goto) {
        // el remate te coloca junto al zombi caído
        const g = this.action.goto;
        const kk = Math.min(1, dt * 9);
        G.World.move(this.pos, (g.x - this.pos.x) * kk, (g.z - this.pos.z) * kk, RADIUS);
        this.vel.x = this.vel.z = 0;
      } else {
        G.World.move(this.pos, this.vel.x * dt, this.vel.z * dt, RADIUS);
      }

      const vlen = Math.hypot(this.vel.x, this.vel.z);
      const moveYaw = Math.atan2(this.vel.x, this.vel.z);
      const camYaw = Math.atan2(f.x, f.z);
      // orientación: al apuntar o atacar el cuerpo mira a la cámara y las piernas van a cualquier lado;
      // si no, el cuerpo gira hacia donde te mueves
      if (this.climb) { /* la fija updateClimb */ }
      else if (this.action) {
        this.facing = U.turnToward(this.facing, this.action.face != null ? this.action.face : camYaw, 14 * dt);
      } else if (this.aiming) {
        this.facing = U.turnToward(this.facing, camYaw, 14 * dt);
      } else if (vlen > 0.2) {
        this.facing = U.turnToward(this.facing, moveYaw, (this.prone ? 3 : (this.running ? 9 : 12)) * dt);
      }
      this.moveRel = vlen > 0.2 ? U.angleDiff(moveYaw, this.facing) : 0;

      // resistencia
      if (this.running) this.stamina = Math.max(0, this.stamina - 0.07 * dt);
      else if (!this.action) this.stamina = Math.min(1, this.stamina + (vlen > 0.2 ? 0.06 : 0.11) * dt);

      // ruido
      const moving = vlen > 0.3;
      if (this.running) { this.noise = NOISE_RUN; this.noiseLevel = 2; }
      else if (moving && this.stance === 'stand') { this.noise = NOISE_WALK; this.noiseLevel = 1; }
      else if (this.prone) { this.noise = 0; this.noiseLevel = 4; }
      else if (this.crouching) { this.noise = 0; this.noiseLevel = 3; }
      else { this.noise = 0; this.noiseLevel = 0; }

      // heridas
      if (this.bleed > 0) {
        this.bleed -= dt;
        this.damage(this.bleedRate * dt);
        this.hurt = Math.max(this.hurt, 0.05);
        if (this.bleed <= 0) this.bleedRate = 0;
      } else if (!this.infected && this.health < 100) {
        this.health = Math.min(100, this.health + 0.25 * dt);
      }
      if (this.infected) {
        this.infectTime += dt;
        if (this.infectTime > 300) { this.sick = true; this.health -= 0.16 * dt; }
      }
      this.hurt = Math.max(0, this.hurt - dt);

      // salto
      if (this.hop) {
        this.hop.t += dt / 0.5;
        this.hopLift = Math.sin(Math.PI * Math.min(1, this.hop.t)) * 0.32;
        if (this.hop.t >= 1) { this.hop = null; this.hopLift = 0; }
      }

      const ref = this.prone ? PRONE_WALK : WALK;
      this.moveAmt += (Math.min(1, vlen / ref) - this.moveAmt) * Math.min(1, dt * 12);
      this.time = (this.time || 0) + dt;
      const rate = this.running ? 11.5 : (this.prone ? 5 : (this.aiming || this.crouching ? 6.5 : 8.2));
      this.phase += dt * rate * (this.moveAmt > 0.05 ? 1 : 0);
      const finisher = this.action && this.action.kind === 'finisher';
      this.crouchAmt += ((this.crouching && !this.climb && !finisher ? 1 : 0) - this.crouchAmt) * Math.min(1, dt * 9);
      this.proneAmt += ((this.prone && !this.climb ? 1 : 0) - this.proneAmt) * Math.min(1, dt * 5);
      this.y += (G.World.groundY(this.pos.x, this.pos.z) - this.y) * Math.min(1, dt * 12);
      if (this.health <= 0 && !this.dead) this.die(this.sick ? 'La infección acabó contigo.' : 'Te desangraste.');
    }

    // Saltar por una ventana abierta o una valla
    startClimb(ref, kind) {
      const W = G.World;
      if (this.stance !== 'stand') this.stance = 'stand';
      const mx = ref.o === 'N' ? ref.x + 0.5 : ref.x;
      const mz = ref.o === 'N' ? ref.z : ref.z + 0.5;
      const nx = ref.o === 'N' ? 0 : 1, nz = ref.o === 'N' ? 1 : 0;
      const side = (this.pos.x - mx) * nx + (this.pos.z - mz) * nz > 0 ? 1 : -1;
      const tx = mx - nx * side * 0.6, tz = mz - nz * side * 0.6;
      if (W.circleBlocked(tx, tz, RADIUS)) return false;
      this.climb = {
        x0: this.pos.x, z0: this.pos.z, x1: tx, z1: tz, t: 0,
        dur: kind === 'fence' ? 0.85 : 1.2, h: kind === 'fence' ? 0.7 : 0.95,
        face: Math.atan2(-nx * side, -nz * side)
      };
      this.action = null;
      return true;
    }

    updateClimb(dt) {
      const c = this.climb;
      c.t += dt / c.dur;
      const t = Math.min(1, c.t);
      this.pos.x = U.lerp(c.x0, c.x1, U.smooth(t));
      this.pos.z = U.lerp(c.z0, c.z1, U.smooth(t));
      this.facing = U.turnToward(this.facing, c.face, 12 * dt);
      this.climbLift = Math.sin(Math.PI * t) * c.h;
      if (c.t >= 1) { this.climb = null; this.climbLift = 0; }
    }

    die(cause) {
      this.dead = true;
      this.deathCause = cause;
      this.deathT = 0;
      this.action = null;
      this.climb = null;
    }

    // Pose y posición del modelo
    apply(dt) {
      const m = this.model;
      m.root.position.set(this.pos.x, this.y + (this.climbLift || 0) + (this.hopLift || 0), this.pos.z);
      m.root.rotation.y = this.facing;
      if (this.dead) {
        this.deathT = Math.min(1, (this.deathT || 0) + (dt || 0) * 1.6);
        G.Models.poseZombie(m, { phase: 0, amt: 0, chase: false, armsUp: 0, reach: 0, stagger: 0, seed: 0, lean: 0, tilt: 0, dt });
        G.Models.poseFall(m, this.deathT, 1);
        return;
      }
      const w = this.weapon;
      const a = this.action;
      G.Models.posePlayer(m, {
        phase: this.phase, amt: this.moveAmt, run: this.running, crouch: this.crouchAmt, prone: this.proneAmt,
        rel: this.moveRel, hop: this.hop ? Math.min(1, this.hop.t) : 0,
        cat: w.cat, two: this.twoHanded, aim: this.aiming || !!a, dt, time: this.time || 0,
        action: a ? a.kind : null, t: a ? Math.min(1, a.t) : 0,
        climb: this.climb ? Math.min(1, this.climb.t) : null,
        weaponCat: w.cat
      });
    }
  }

  G.Player = Player;
})(window.Game = window.Game || {});
