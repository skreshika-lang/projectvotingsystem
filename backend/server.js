// ============================================================
//  TrueVote Backend – Fixed MongoDB Connection + Robust Logic
// ============================================================

// ✅ FIX 1: Override Node's DNS resolver to use Google DNS
//    (solves "querySrv ECONNREFUSED" on some machines)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

const crypto  = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const User = require('./models/User');

// ✅ FIX 2: Robust Mongoose connection with retry logic
const MONGO_URL = process.env.MONGO_URL;
if (!MONGO_URL) {
  console.error('❌ MONGO_URL is not set in .env file!');
  process.exit(1);
}

const mongoOptions = {
  serverSelectionTimeoutMS: 30000,  // 30s to find a server
  socketTimeoutMS:          45000,  // 45s socket timeout
  connectTimeoutMS:         20000,  // 20s to establish connection
  maxPoolSize:              10,
  retryWrites:              true,
  family:                   4,      // force IPv4 (avoids IPv6 DNS issues)
};

function connectWithRetry(attempt = 1) {
  console.log(`🔄 MongoDB connection attempt ${attempt}...`);
  mongoose.connect(MONGO_URL, mongoOptions)
    .then(() => {
      console.log('✅ MongoDB Connected Successfully!');
    })
    .catch((err) => {
      console.error(`❌ MongoDB connection failed (attempt ${attempt}):`, err.message);
      if (attempt < 5) {
        const delay = attempt * 3000; // 3s, 6s, 9s, 12s
        console.log(`⏳ Retrying in ${delay / 1000}s...`);
        setTimeout(() => connectWithRetry(attempt + 1), delay);
      } else {
        console.error('💥 MongoDB: Max retries reached. Check your Atlas credentials & Network Access whitelist.');
        console.error('   → Go to: https://cloud.mongodb.com → Network Access → Add IP (0.0.0.0/0 for dev)');
        console.error('   → Check: Database Access → user password matches MONGO_URL in .env');
      }
    });
}

// Handle dropped connections — auto-reconnect
mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected. Attempting reconnect...');
  setTimeout(() => connectWithRetry(), 5000);
});
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB error:', err.message);
});

connectWithRetry();

// ─── Static files ────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

// ─── Helpers ─────────────────────────────────────────────────
function euclideanDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.pow(a[i] - b[i], 2);
  return Math.sqrt(s);
}

// ─── Health check endpoint ───────────────────────────────────
app.get('/api/health', (req, res) => {
  const dbState = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    db: dbState[mongoose.connection.readyState] || 'unknown',
    time: new Date().toISOString()
  });
});

// ─── REGISTER ────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, aadharNumber, mobileNumber, voterId, faceData, faceDescriptor } = req.body;

    if (!name || !aadharNumber || !voterId || !mobileNumber)
      return res.status(400).json({ message: '❌ All fields are required!' });

    // Check duplicates
    if (await User.findOne({ aadharNumber }))
      return res.status(400).json({ message: `🚫 Aadhaar ${aadharNumber} already registered!` });
    if (await User.findOne({ voterId }))
      return res.status(400).json({ message: `🚫 VoterID ${voterId} already registered!` });
    if (await User.findOne({ mobileNumber }))
      return res.status(400).json({ message: `🚫 Mobile ${mobileNumber} already registered!` });

    // Face duplicate check — One Person One Vote
    if (faceDescriptor && faceDescriptor.length > 0) {
      const allUsers = await User.find({ faceDescriptor: { $exists: true, $ne: [] } });
      for (const u of allUsers) {
        if (u.faceDescriptor && u.faceDescriptor.length > 0) {
          const distance = euclideanDistance(faceDescriptor, u.faceDescriptor);
          if (distance < 0.5) {
            return res.status(400).json({
              message: `🚫 Same Face already registered as ${u.name}! One Person One Vote!`
            });
          }
        }
      }
    }

    const newUser = new User({
      name, aadharNumber, mobileNumber, voterId,
      faceData, faceDescriptor, hasVoted: false
    });
    await newUser.save();
    res.json({ message: '✅ Registered Successfully! You can Login now!' });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { aadharNumber, voterId } = req.body;
    const user = await User.findOne({ aadharNumber, voterId });
    if (!user) return res.status(400).json({ message: '❌ User not found — Register first!' });
    if (user.hasVoted) return res.status(400).json({ message: '🚫 You already voted! One Person One Vote.' });
    res.json({ message: 'Login Success', user });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ─── VOTE ────────────────────────────────────────────────────
app.post('/api/vote', async (req, res) => {
  try {
    const { aadharNumber, votedFor } = req.body;
    const user = await User.findOne({ aadharNumber });
    if (!user) return res.status(404).json({ message: '❌ User not found — Register again' });
    if (user.hasVoted) return res.status(400).json({ message: '🚫 You already voted!' });

    user.hasVoted = true;
    user.votedFor = votedFor;

    // Blockchain hash-chain
    const lastBlock = await User.findOne({ hasVoted: true, currentHash: { $exists: true } })
      .sort({ blockIndex: -1 });
    const prevHash  = lastBlock ? lastBlock.currentHash : '0';
    const blockIndex = lastBlock ? lastBlock.blockIndex + 1 : 1;
    const blockData  = user.aadharNumber + votedFor + Date.now() + prevHash + blockIndex;
    const currHash   = crypto.createHash('sha256').update(blockData).digest('hex');

    user.previousHash = prevHash;
    user.currentHash  = currHash;
    user.blockIndex   = blockIndex;
    user.votedAt      = new Date();

    console.log(`✅ Block #${blockIndex} | Prev: ${prevHash.substring(0, 8)}... | Curr: ${currHash.substring(0, 8)}...`);

    await user.save();
    res.json({
      message: `✅ Vote for ${votedFor} recorded! Block #${blockIndex} — Hash: ${currHash.substring(0, 12)}...`
    });
  } catch (e) {
    console.error('Vote error:', e);
    res.status(500).json({ message: e.message });
  }
});

// ─── RESULTS ─────────────────────────────────────────────────
app.get('/api/results', async (req, res) => {
  try {
    const users  = await User.find({ hasVoted: true }).sort({ blockIndex: 1 });
    const counts = {};
    users.forEach(u => { counts[u.votedFor] = (counts[u.votedFor] || 0) + 1; });
    res.json({ totalVoted: users.length, counts, users, blockchainValid: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── VERIFY BLOCKCHAIN ───────────────────────────────────────
app.get('/api/verify-chain', async (req, res) => {
  try {
    const chain = await User.find({ hasVoted: true, currentHash: { $exists: true } })
      .sort({ blockIndex: 1 });
    let valid = true, message = 'Blockchain Valid — No Tampering';
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].previousHash !== chain[i - 1].currentHash) {
        valid = false;
        message = `Chain BROKEN at Block #${chain[i].blockIndex}! Tampering detected!`;
        break;
      }
    }
    res.json({ valid, message, totalBlocks: chain.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ─── START SERVER ────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✅ TrueVote server running on http://localhost:${PORT}`);
  console.log(`   Open: http://localhost:${PORT}/index.html`);
});
