const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 常量配置 ====================
const CONFIG = {
    INITIAL_COINS: 1000,
    ANTE_OPTIONS: [10, 50, 100],
    DEFAULT_ANTE: 10,
    RAKE_RATE: 0.1,
    TURN_SECONDS: 30,
    ROOM_COUNT: 3,
    ADMIN_PASSWORD: 'aaaa6666',
    SUITS: ['♠', '♥', '♣', '♦'],
    RANKS: ['2','3','4','5','6','7','8','9','10','J','Q','K','A'],
    RANK_VAL: {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}
};

const HAND_NAMES = ['单张','对子','顺子','金花','顺金','豹子'];

// ==================== 工具函数 ====================
function randomPwd() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function evaluateHand(cards) {
    const sorted = [...cards].sort((a,b) => CONFIG.RANK_VAL[b.rank] - CONFIG.RANK_VAL[a.rank]);
    const vals = sorted.map(c => CONFIG.RANK_VAL[c.rank]);
    const suits = sorted.map(c => c.suit);
    
    const flush = suits[0] === suits[1] && suits[1] === suits[2];
    const s = [...vals].sort((a,b) => a-b);
    const straight = (s[2]-s[1]===1 && s[1]-s[0]===1) 
        ? 'normal' 
        : (s[0]===2 && s[1]===3 && s[2]===14 ? 'low' : false);
    
    const counts = {};
    vals.forEach(v => counts[v] = (counts[v]||0) + 1);
    const countVals = Object.values(counts).sort((a,b) => b-a);
    
    let level = 0;
    let highCards = vals;
    
    if (countVals[0] === 3) level = 5;
    else if (flush && straight) {
        level = 4;
        if (straight === 'low') highCards = [3,2,1];
    }
    else if (flush) level = 3;
    else if (straight) {
        level = 2;
        if (straight === 'low') highCards = [3,2,1];
    }
    else if (countVals[0] === 2) {
        level = 1;
        const pairVal = +Object.keys(counts).find(k => counts[k]===2);
        const single = vals.find(v => v !== pairVal);
        highCards = [pairVal, pairVal, single];
    }
    
    const is235 = vals.includes(2) && vals.includes(3) && vals.includes(5) && !flush;
    return { level, highCards, is235 };
}

function compareHand(h1, h2) {
    if (h1.is235 && h2.is235) return 0;
    if (h1.is235 && h2.level === 5) return 1;
    if (h2.is235 && h1.level === 5) return -1;
    if (h1.level !== h2.level) return h1.level - h2.level;
    for (let i = 0; i < 3; i++) {
        if (h1.highCards[i] !== h2.highCards[i]) return h1.highCards[i] - h2.highCards[i];
    }
    return 0;
}

function getHandName(hand) {
    if (hand.is235) return '235特殊';
    return HAND_NAMES[hand.level];
}

function getActualBet(player, baseBet) {
    return Math.max(baseBet, player.isBlind ? baseBet : baseBet * 2);
}

// ==================== 房间类 ====================
class GameRoom {
    constructor(id) {
        this.id = id;
        this.seatPasswords = Array(4).fill(0).map(() => randomPwd());
        this.seatsOccupied = [false,false,false,false];
        this.seatsReady = [false,false,false,false];
        this.currentAnte = CONFIG.DEFAULT_ANTE;
        this.isPlaying = false;
        this.players = [];
        this.deck = [];
        this.pot = 0;
        this.currentBaseBet = 0;
        this.currentPlayer = 0;
        this.roundNum = 1;
        this.gameOver = false;
        this.dealerIndex = 0;
        this.timeLeft = 0;
        this.turnTimer = null;
        this.logs = [];
    }

    log(text) {
        this.logs.unshift({ text, time: Date.now() });
        if (this.logs.length > 100) this.logs.length = 100;
    }

    initPlayers() {
        this.players = [];
        for (let i = 0; i < 4; i++) {
            this.players.push({
                id: i,
                name: `玩家${i+1}`,
                coins: this.seatsOccupied[i] ? CONFIG.INITIAL_COINS : 0,
                cards: [],
                bet: 0,
                folded: !this.seatsOccupied[i],
                bankrupt: !this.seatsOccupied[i],
                isBlind: true,
                selectedAnte: CONFIG.DEFAULT_ANTE
            });
        }
    }

    createDeck() {
        this.deck = [];
        CONFIG.SUITS.forEach(s => {
            CONFIG.RANKS.forEach(r => this.deck.push({suit: s, rank: r}));
        });
        for (let i = this.deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
        }
    }

    dealCards() {
        for (let i = 0; i < 3; i++) {
            this.players.forEach(p => {
                if (!p.bankrupt) p.cards.push(this.deck.pop());
            });
        }
    }

    startGame() {
        this.isPlaying = true;
        this.roundNum = 1;
        this.dealerIndex = 0;
        this.log('游戏开始！每人初始筹码 ' + CONFIG.INITIAL_COINS);
        this.startRound();
    }

    startRound() {
        this.gameOver = false;
        this.pot = 0;
        this.currentBaseBet = this.currentAnte;
        
        this.players.forEach(p => {
            p.cards = [];
            p.bet = 0;
            p.folded = p.bankrupt;
            p.isBlind = true;
        });

        // 扣底注
        this.players.forEach(p => {
            if (!p.bankrupt && p.coins >= this.currentAnte) {
                p.coins -= this.currentAnte;
                p.bet = this.currentAnte;
                this.pot += this.currentAnte;
            } else if (!p.bankrupt) {
                p.bankrupt = true;
                p.folded = true;
                this.log(`${p.name} 破产出局`);
            }
        });

        this.createDeck();
        this.dealCards();

        // 从庄家下家开始
        this.currentPlayer = (this.dealerIndex + 1) % 4;
        let count = 0;
        while ((this.players[this.currentPlayer].bankrupt || this.players[this.currentPlayer].folded) && count < 4) {
            this.currentPlayer = (this.currentPlayer + 1) % 4;
            count++;
        }
        
        this.log(`--- 第 ${this.roundNum} 局 ---`);
        this.log(`扣底注 ${this.currentAnte}`);
        this.startTurnTimer();
        
        const alive = this.players.filter(p => !p.folded && !p.bankrupt);
        if (alive.length <= 1) this.endGame(alive[0]);
    }

    startTurnTimer() {
        this.stopTurnTimer();
        this.timeLeft = CONFIG.TURN_SECONDS;
        this.turnTimer = setInterval(() => {
            this.timeLeft--;
            if (this.timeLeft <= 0) {
                this.stopTurnTimer();
                const p = this.players[this.currentPlayer];
                if (!p.folded && !p.bankrupt) {
                    this.log('⏰ 超时！自动弃牌');
                    p.folded = true;
                    this.nextPlayer();
                }
            }
        }, 1000);
    }

    stopTurnTimer() {
        if (this.turnTimer) {
            clearInterval(this.turnTimer);
            this.turnTimer = null;
        }
    }

    nextPlayer() {
        let next = (this.currentPlayer + 1) % 4;
        let count = 0;
        while ((this.players[next].folded || this.players[next].bankrupt) && count < 4) {
            next = (next + 1) % 4;
            count++;
        }
        this.currentPlayer = next;
        
        const alive = this.players.filter(p => !p.folded && !p.bankrupt);
        const allSame = alive.every(p => Math.abs(p.bet - getActualBet(p, this.currentBaseBet)) < 1);
        if (allSame && alive.length > 1) this.log('--- 下一轮 ---');
        
        if (alive.length === 1) {
            this.endGame(alive[0]);
            return;
        }
        
        this.startTurnTimer();
    }

    endGame(winner) {
        this.gameOver = true;
        this.stopTurnTimer();
        
        const rake = Math.floor(this.pot * CONFIG.RAKE_RATE);
        const win = this.pot - rake;
        winner.coins += win;
        
        this.log(`${winner.name} 赢 ${win}，抽水${rake}`);
        this.dealerIndex = winner.id;
        
        // 检查破产
        this.players.forEach(p => {
            if (!p.bankrupt && p.coins < this.currentAnte) {
                p.bankrupt = true;
                this.log(`${p.name} 破产`);
            }
        });
    }

    nextRound() {
        const alive = this.players.filter(p => !p.bankrupt);
        if (alive.length <= 1) return false;
        this.roundNum++;
        this.startRound();
        return true;
    }

    // 玩家操作
    playerLook(seat) {
        if (this.gameOver || this.players[seat].folded || this.players[seat].bankrupt) return false;
        this.players[seat].isBlind = false;
        this.log(`${this.players[seat].name} 看牌了`);
        return true;
    }

    playerFold(seat) {
        if (this.gameOver || this.currentPlayer !== seat) return false;
        this.stopTurnTimer();
        this.players[seat].folded = true;
        this.log(`${this.players[seat].name} 弃牌了`);
        this.nextPlayer();
        return true;
    }

    playerCall(seat) {
        if (this.gameOver || this.currentPlayer !== seat) return { ok:false, msg:'非法操作' };
        const p = this.players[seat];
        const need = getActualBet(p, this.currentBaseBet) - p.bet;
        if (p.coins < need) return { ok:false, msg:'筹码不足' };
        
        this.stopTurnTimer();
        p.coins -= need;
        p.bet += need;
        this.pot += need;
        this.log(`${p.name} 跟注 ${need}`);
        this.nextPlayer();
        return { ok:true };
    }

    playerRaise(seat, amount) {
        if (this.gameOver || this.currentPlayer !== seat) return { ok:false, msg:'非法操作' };
        const p = this.players[seat];
        const newBase = this.currentBaseBet + amount;
        const newActual = getActualBet(p, newBase);
        const need = newActual - p.bet;
        if (p.coins < need) return { ok:false, msg:'筹码不足' };
        
        this.stopTurnTimer();
        p.coins -= need;
        p.bet += need;
        this.pot += need;
        this.currentBaseBet = newBase;
        this.log(`${p.name} 加注至 ${p.bet}`);
        this.nextPlayer();
        return { ok:true };
    }

    playerCompare(seat) {
        if (this.gameOver || this.currentPlayer !== seat) return { ok:false, msg:'非法操作' };
        
        const alive = this.players.filter(pl => pl.id !== seat && !pl.folded && !pl.bankrupt);
        if (alive.length !== 1) return { ok:false, msg:'仅剩最后两名玩家时才可以比牌' };
        
        const p = this.players[seat];
        const need = getActualBet(p, this.currentBaseBet) - p.bet;
        if (p.coins < need) return { ok:false, msg:'筹码不足' };
        
        this.stopTurnTimer();
        p.coins -= need;
        p.bet += need;
        this.pot += need;
        
        const target = alive[0];
        this.log(`${p.name} 和 ${target.name} 比牌`);
        
        const s1 = evaluateHand(p.cards);
        const s2 = evaluateHand(target.cards);
        const cmp = compareHand(s1, s2);
        const winner = cmp > 0 ? p : target;
        const loser = winner.id === seat ? target : p;
        loser.folded = true;
        
        this.log(`${winner.name} 赢`);
        this.nextPlayer();
        return { ok:true };
    }

    playerLeave(seat) {
        if (this.isPlaying && this.players[seat] && !this.players[seat].folded && !this.players[seat].bankrupt) {
            this.players[seat].folded = true;
            this.log(`玩家${seat+1}退出，自动弃牌`);
            const alive = this.players.filter(p => !p.folded && !p.bankrupt);
            if (alive.length === 1) this.endGame(alive[0]);
        }
        
        this.seatsOccupied[seat] = false;
        this.seatsReady[seat] = false;
        this.seatPasswords[seat] = randomPwd();
        if (this.players[seat]) {
            this.players[seat].cards = [];
            this.players[seat].coins = 0;
        }
    }

    // 管理员操作
    adminAddCoins(seat, amount) {
        if (!this.players || this.players.length === 0) this.initPlayers();
        if (this.players[seat]) {
            this.players[seat].coins += amount;
            if (this.players[seat].bankrupt && this.players[seat].coins >= this.currentAnte) {
                this.players[seat].bankrupt = false;
                this.players[seat].folded = false;
            }
        }
    }

    adminChangeCards(seat, cards) {
        if (this.players[seat] && !this.players[seat].bankrupt && !this.players[seat].folded) {
            this.players[seat].cards = cards;
        }
    }

    // 输出给玩家的数据
    getPlayerView(seat) {
        return {
            id: this.id,
            seatsOccupied: this.seatsOccupied,
            seatsReady: this.seatsReady,
            currentAnte: this.currentAnte,
            isPlaying: this.isPlaying,
            pot: this.pot,
            currentBaseBet: this.currentBaseBet,
            currentPlayer: this.currentPlayer,
            roundNum: this.roundNum,
            gameOver: this.gameOver,
            timeLeft: this.timeLeft,
            dealerIndex: this.dealerIndex,
            players: this.players.map((p, idx) => ({
                id: idx,
                name: p.name,
                coins: p.coins,
                bet: p.bet,
                folded: p.folded,
                bankrupt: p.bankrupt,
                isBlind: p.isBlind,
                cards: idx === seat ? p.cards : [],
                handName: idx === seat && !p.isBlind && p.cards.length === 3 ? getHandName(evaluateHand(p.cards)) : ''
            })),
            winner: this.gameOver ? {
                name: this.players[this.dealerIndex].name,
                cards: this.players[this.dealerIndex].cards,
                handName: getHandName(evaluateHand(this.players[this.dealerIndex].cards)),
                win: this.pot - Math.floor(this.pot * CONFIG.RAKE_RATE),
                rake: Math.floor(this.pot * CONFIG.RAKE_RATE)
            } : null
        };
    }

    // 输出给管理员的数据
    getAdminView() {
        return {
            id: this.id,
            seatPasswords: this.seatPasswords,
            seatsOccupied: this.seatsOccupied,
            seatsReady: this.seatsReady,
            currentAnte: this.currentAnte,
            isPlaying: this.isPlaying,
            pot: this.pot,
            currentBaseBet: this.currentBaseBet,
            currentPlayer: this.currentPlayer,
            roundNum: this.roundNum,
            gameOver: this.gameOver,
            timeLeft: this.timeLeft,
            logs: this.logs,
            players: this.players.map(p => ({
                ...p,
                handName: p.cards.length === 3 ? getHandName(evaluateHand(p.cards)) : ''
            }))
        };
    }
}

// ==================== 初始化房间 ====================
const rooms = [];
for (let i = 0; i < CONFIG.ROOM_COUNT; i++) {
    rooms.push(new GameRoom(i + 1));
}

// ==================== 路由 ====================

// 房间列表
app.get('/api/rooms', (req, res) => {
    res.json(rooms.map(r => ({
        id: r.id,
        count: r.seatsOccupied.filter(s => s).length,
        isPlaying: r.isPlaying
    })));
});

// 获取房间信息（玩家视角）
app.get('/api/room/:id', (req, res) => {
    const room = rooms[req.params.id - 1];
    if (!room) return res.status(404).json({error: '房间不存在'});
    const seat = parseInt(req.query.seat || '-1');
    res.json(room.getPlayerView(seat));
});

// 入座
app.post('/api/room/:id/sit', (req, res) => {
    const room = rooms[req.params.id - 1];
    if (!room) return res.status(404).json({error: '房间不存在'});
    const { seat, password } = req.body;
    
    if (seat < 0 || seat > 3) return res.status(400).json({error: '座位无效'});
    if (room.seatsOccupied[seat]) return res.status(400).json({error: '座位已有人'});
    if (room.seatPasswords[seat] !== password) return res.status(400).json({error: '密码错误'});
    
    room.seatsOccupied[seat] = true;
    room.seatsReady[seat] = false;
    if (room.players.length === 0) room.initPlayers();
    room.players[seat].bankrupt = false;
    room.players[seat].folded = false;
    room.players[seat].coins = CONFIG.INITIAL_COINS;
    room.log(`玩家${seat+1}入座`);
    
    res.json({success: true});
});

// 选择底注
app.post('/api/room/:id/ante', (req, res) => {
    const room = rooms[req.params.id - 1];
    if (!room || room.isPlaying) return res.status(400).json({error: '非法操作'});
    const { seat, ante } = req.body;
    
    if (!CONFIG.ANTE_OPTIONS.includes(ante)) return res.status(400).json({error: '底注无效'});
    room.players[seat].selectedAnte = ante;
    res.json({success: true});
});

// 准备/取消准备
app.post('/api/room/:id/ready', (req, res) => {
    const room = rooms[req.params.id - 1];
    if (!room || room.isPlaying) return res.status(400).json({error: '非法操作'});
    const { seat, ready } = req.body;
    
    room.seatsReady[seat] = ready;
    
    const occupiedIdx = [];
    for (let i = 0; i < 4; i++) {
        if (room.seatsOccupied[i]) occupiedIdx.push(i);
    }
    
    if (occupiedIdx.length >= 2) {
        const antes = new Set(occupiedIdx.map(i => room.players[i].selectedAnte));
        if (antes.size === 1 && occupiedIdx.every(i => room.seatsReady[i])) {
            room.currentAnte = [...antes][0];
            setTimeout(() => room.startGame(), 1000);
        }
    }
    
    res.json({success: true});
});

// 看牌
app.post('/api/room/:id/look', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat } = req.body;
    room.playerLook(seat);
    res.json({success: true});
});

// 弃牌
app.post('/api/room/:id/fold', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat } = req.body;
    room.playerFold(seat);
    res.json({success: true});
});

// 跟注
app.post('/api/room/:id/call', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat } = req.body;
    const result = room.playerCall(seat);
    res.json(result);
});

// 加注
app.post('/api/room/:id/raise', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat, amount } = req.body;
    const result = room.playerRaise(seat, amount);
    res.json(result);
});

// 比牌
app.post('/api/room/:id/compare', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat } = req.body;
    const result = room.playerCompare(seat);
    res.json(result);
});

// 退出
app.post('/api/room/:id/leave', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat } = req.body;
    room.playerLeave(seat);
    res.json({success: true});
});

// 下一局
app.post('/api/room/:id/next', (req, res) => {
    const room = rooms[req.params.id - 1];
    if (!room.gameOver) return res.status(400).json({error: '游戏未结束'});
    const ok = room.nextRound();
    res.json({success: ok});
});

// ========== 管理员接口 ==========
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === CONFIG.ADMIN_PASSWORD) {
        res.json({success: true});
    } else {
        res.status(400).json({error: '密码错误'});
    }
});

app.get('/api/admin/room/:id', (req, res) => {
    const room = rooms[req.params.id - 1];
    if (!room) return res.status(404).json({error: '房间不存在'});
    res.json(room.getAdminView());
});

app.post('/api/admin/room/:id/addcoins', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat, amount } = req.body;
    room.adminAddCoins(seat, amount);
    res.json({success: true});
});

app.post('/api/admin/room/:id/changecards', (req, res) => {
    const room = rooms[req.params.id - 1];
    const { seat, cards } = req.body;
    room.adminChangeCards(seat, cards);
    res.json({success: true});
});

// 启动
app.listen(PORT, () => {
    console.log(`炸金花服务已启动: http://localhost:${PORT}`);
});