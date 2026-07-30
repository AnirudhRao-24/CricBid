        import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
        import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
        import { getFirestore, collection, doc, setDoc, getDoc, getDocs, updateDoc, onSnapshot, writeBatch, serverTimestamp, deleteDoc, runTransaction } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        
        // Exact config provided by user
        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {
            apiKey: "AIzaSyCAd5OJKmVW2aSWgDogBg3lSpj1uzPxGrk",
            authDomain: "cricbid-839eb.firebaseapp.com",
            projectId: "cricbid-839eb",
            storageBucket: "cricbid-839eb.firebasestorage.app",
            messagingSenderId: "521652177425",
            appId: "1:521652177425:web:c33adfb7ea97360d6affb0",
            measurementId: "G-7WHCC3VSTW"
        };

        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const db = getFirestore(app);

        // Database References
        const getRoomsRef = () => collection(db, 'artifacts', appId, 'public', 'data', 'rooms');
        const getUsersRef = () => collection(db, 'artifacts', appId, 'public', 'data', 'users');
        const getPlayersRef = () => collection(db, 'artifacts', appId, 'public', 'data', 'players');
        const getChatRef = (roomId) => collection(db, 'artifacts', appId, 'public', 'data', 'messages_' + roomId);
        const getPresenceRef = () => collection(db, 'artifacts', appId, 'public', 'data', 'presence');
        const getInvitesRef = () => collection(db, 'artifacts', appId, 'public', 'data', 'invites');

        let currentUser = null;
        let currentRoomId = null;
        let myUserDocId = null;
        let myPresenceId = null;
        
        let roomData = null;
        let usersData = [];
        let playersData = [];
        let chatMessages = [];
        let globalPlayers = [];
        let lastViewedMessageCount = 0;
        
        let timerInterval = null;
        let failoverTimer = null;
        let playerToKick = null;
        let playerToBan = null;
        let heartbeatInterval = null;
        let transferTimerInterval = null;

        let seasonData = null;
        let selectedTransferRelease = null;
        let selectedTransferSign = null;
        let draftModalDismissed = false;

        let peer = null;
        let myPeerId = null;
        let connectedPeers = new Set();
        let activeStreams = new Map();
        let localStream = null;
        let isMicMuted = true;
        let isVideoMuted = true;
        let lastBidderState = null;

        let playerStatsCache = {};
        let activeFetches = {};
        let inviteCooldowns = {};

        let serverTimeOffset = 0;
        const getServerTime = () => Date.now() + serverTimeOffset;

        // === UI Helpers to hide/show overlapping floating buttons for iOS ===
        window.hideFloatingButtons = () => {
            ['btn-desktop-chat', 'btn-ai-coach', 'reaction-buttons'].forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.classList.add('hidden');
                    el.classList.remove('flex');
                }
            });
        };

        window.showFloatingButtons = () => {
            const chatBtn = document.getElementById('btn-desktop-chat');
            if (chatBtn) chatBtn.classList.remove('hidden');
            
            const aiBtn = document.getElementById('btn-ai-coach');
            if (aiBtn) aiBtn.classList.remove('hidden');

            if (currentRoomId && roomData && roomData.status !== 'season') {
                const reactBtns = document.getElementById('reaction-buttons');
                const auctionScreen = document.getElementById('auction-screen');
                if (reactBtns && auctionScreen && !auctionScreen.classList.contains('hidden')) {
                    reactBtns.classList.remove('hidden');
                    reactBtns.classList.add('flex');
                }
            }
        };

        // AI Feature Logic
        window.openAICoach = async () => {
            hideFloatingButtons();
            const modal = document.getElementById('ai-coach-modal');
            const loading = document.getElementById('ai-coach-loading');
            const content = document.getElementById('ai-coach-content');
            
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => { modal.classList.remove('opacity-0'); modal.querySelector('.glass-panel').classList.remove('scale-95'); }, 10);
            
            loading.classList.remove('hidden'); loading.classList.add('flex');
            content.classList.add('hidden'); content.classList.remove('flex');

            const me = usersData.find(u => u.userId === myUserDocId);
            if (!me) { showToast("Error loading user data."); closeAICoach(); return; }

            const myPlayers = playersData.filter(p => p.ownerId === myUserDocId);
            const mySquadStr = myPlayers.length > 0 ? myPlayers.map(p => `${p.name} (${p.role})`).join(', ') : "No players drafted yet.";
            
            const availablePlayers = playersData.filter(p => p.status === 'upcoming' || p.status === 'unsold');
            const poolStr = availablePlayers.length > 0 ? availablePlayers.map(p => `${p.name} (${p.role}, â‚¹${p.basePrice || p.base}Cr)`).join(', ') : "No players left in pool.";

            const prompt = `Act as an expert Cricket Auction Strategist.
My Budget: â‚¹${me.budget.toFixed(2)} Cr.
My Drafted Squad: ${mySquadStr}
Available Players in Pool: ${poolStr}

Analyze my squad's balance (e.g., missing strong openers, lack of spin depth). Then, recommend exactly 3 players to target from the "Available Players in Pool" to fix my weaknesses, considering my remaining budget. Do not suggest players I already own or are not in the pool. If the pool is empty, just advise me to wait for the season.
Return JSON exactly matching this schema:
{
  "balanceAnalysis": "A concise paragraph analyzing my team's strengths and weaknesses.",
  "targets": [
     { "name": "Player Name", "reason": "Short reason why they fit my team and budget." }
  ]
}`;

            try {
                const payload = {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                "balanceAnalysis": { "type": "STRING" },
                                "targets": {
                                    "type": "ARRAY",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": { "name": { "type": "STRING" }, "reason": { "type": "STRING" } },
                                        "required": ["name", "reason"]
                                    }
                                }
                            },
                            required: ["balanceAnalysis", "targets"]
                        }
                    }
                };

                const apiKey = typeof __gemini_api_key !== 'undefined' ? __gemini_api_key : "";
                
                if (!apiKey) {
                    // MOCK FALLBACK
                    await new Promise(r => setTimeout(r, 1200));
                    document.getElementById('ai-coach-analysis').innerText = "Based on your current setup (simulated), you might be missing some depth. Consider targeting high-value players remaining in the pool to balance your team.";
                    const targetsContainer = document.getElementById('ai-coach-targets');
                    targetsContainer.innerHTML = availablePlayers.slice(0, 3).map(p => `
                        <div class="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 shadow-inner">
                            <h4 class="text-sm font-bold text-white mb-1">${p.name}</h4>
                            <p class="text-xs text-zinc-400 leading-relaxed">Great ${p.role.toLowerCase()} addition.</p>
                        </div>
                    `).join('') || '<p class="text-xs text-zinc-500 italic">No targets available.</p>';
                    loading.classList.add('hidden'); loading.classList.remove('flex');
                    content.classList.remove('hidden'); content.classList.add('flex');
                    return;
                }

                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
                
                let result = null;
                let retries = 3;
                let delay = 1000;

                for (let i = 0; i < retries; i++) {
                    try {
                        if (!apiKey) throw new Error("No API Key available in environment context.");
                        const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                        if (!response.ok) throw new Error('API Error');
                        result = await response.json();
                        break;
                    } catch (err) {
                        if (i === retries - 1) throw err;
                        await new Promise(res => setTimeout(res, delay)); delay *= 2;
                    }
                }
                
                const jsonText = result.candidates[0].content.parts[0].text;
                const data = JSON.parse(jsonText);

                document.getElementById('ai-coach-analysis').innerText = data.balanceAnalysis;
                
                const targetsContainer = document.getElementById('ai-coach-targets');
                targetsContainer.innerHTML = '';
                if (data.targets && data.targets.length > 0) {
                    data.targets.forEach(t => {
                        targetsContainer.innerHTML += `
                            <div class="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 shadow-inner">
                                <h4 class="text-sm font-bold text-white mb-1">${t.name}</h4>
                                <p class="text-xs text-zinc-400 leading-relaxed">${t.reason}</p>
                            </div>
                        `;
                    });
                } else {
                    targetsContainer.innerHTML = '<p class="text-xs text-zinc-500 italic">No specific targets recommended.</p>';
                }

                loading.classList.add('hidden'); loading.classList.remove('flex');
                content.classList.remove('hidden'); content.classList.add('flex');
            } catch (err) {
                console.error("AI Coach Error:", err);
                closeAICoach();
                showToast("AI Coach is currently unavailable. Try again later.");
            }
        };

        window.closeAICoach = () => {
            const modal = document.getElementById('ai-coach-modal');
            modal.classList.add('opacity-0');
            modal.querySelector('.glass-panel').classList.add('scale-95');
            setTimeout(() => { 
                modal.classList.add('hidden'); 
                modal.classList.remove('flex'); 
                showFloatingButtons();
            }, 300);
        };

        window.openAIPreview = async () => {
            hideFloatingButtons();
            const modal = document.getElementById('ai-preview-modal');
            const loading = document.getElementById('ai-preview-loading');
            const content = document.getElementById('ai-preview-content');
            
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => { modal.classList.remove('opacity-0'); modal.querySelector('.glass-panel').classList.remove('scale-95'); }, 10);
            
            loading.classList.remove('hidden'); loading.classList.add('flex');
            content.classList.add('hidden'); content.classList.remove('flex');

            const activeTeams = usersData.filter(u => !u.kicked && !u.banned && playersData.some(p => p.ownerId === u.userId));
            if (activeTeams.length === 0) {
                closeAIPreview();
                showToast("Not enough teams with players to preview.");
                return;
            }

            let squadsInfo = "";
            activeTeams.forEach(t => {
                const teamPlayers = playersData.filter(p => p.ownerId === t.userId);
                squadsInfo += `Franchise: ${t.username}\nPlayers: ${teamPlayers.map(p => p.name + " (" + p.role + ")").join(', ')}\n\n`;
            });

            const prompt = `Act as an expert Cricket Pundit evaluating a completed draft/auction.
Here are the participating franchises and their finalized squads:
${squadsInfo}

Task 1: Evaluate all franchises and pick the single strongest team likely to win the tournament based on overall balance, star power, and depth. Provide a short analytical explanation.
Task 2: Select a "Tournament Best XI" by combining the absolute best players from ALL franchises combined to form a realistic cricket XI (Openers, Middle Order, All-Rounders, Spinners, Pacers).

Return JSON exactly matching this schema:
{
   "bestFranchise": "Name of the winning franchise",
   "analysis": "Short explanation of why their squad is the best",
   "bestXI": [
      { "name": "Player Name", "role": "Specific role (e.g. Opener, Pacer)", "franchise": "Franchise Name" }
   ]
}`;

            try {
                const payload = {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                "bestFranchise": { "type": "STRING" },
                                "analysis": { "type": "STRING" },
                                "bestXI": {
                                    "type": "ARRAY",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "name": { "type": "STRING" },
                                            "role": { "type": "STRING" },
                                            "franchise": { "type": "STRING" }
                                        },
                                        "required": ["name", "role", "franchise"]
                                    }
                                }
                            },
                            required: ["bestFranchise", "analysis", "bestXI"]
                        }
                    }
                };

                const apiKey = typeof __gemini_api_key !== 'undefined' ? __gemini_api_key : "";
                
                if (!apiKey) {
                    // MOCK FALLBACK
                    await new Promise(r => setTimeout(r, 1200));
                    const best = activeTeams[0]?.username || "Unknown Team";
                    document.getElementById('ai-preview-best-team').innerText = best;
                    document.getElementById('ai-preview-analysis').innerText = `${best} executed a fantastic draft strategy (simulated analysis).`;
                    
                    const xiContainer = document.getElementById('ai-preview-xi');
                    const mockPlayers = playersData.filter(p => p.ownerId).slice(0, 4);
                    xiContainer.innerHTML = mockPlayers.map(p => {
                        const owner = usersData.find(u => u.userId === p.ownerId)?.username || "Unknown";
                        return `
                            <div class="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 flex justify-between items-center shadow-inner hover:bg-zinc-900 transition-colors">
                                <div class="overflow-hidden pr-2">
                                    <h4 class="text-sm font-bold text-white truncate">${p.name}</h4>
                                    <p class="text-[9px] text-zinc-500 uppercase tracking-widest truncate">${p.role}</p>
                                </div>
                                <span class="bg-blue-900/30 text-blue-400 border border-blue-500/30 text-[9px] font-bold px-2 py-1 rounded truncate max-w-[100px] shrink-0">${owner}</span>
                            </div>
                        `;
                    }).join('');

                    loading.classList.add('hidden'); loading.classList.remove('flex');
                    content.classList.remove('hidden'); content.classList.add('flex');
                    return;
                }

                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;
                
                let result = null;
                let retries = 3;
                let delay = 1000;

                for (let i = 0; i < retries; i++) {
                    try {
                        if (!apiKey) throw new Error("No API Key available in environment context.");
                        const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                        if (!response.ok) throw new Error('API Error');
                        result = await response.json();
                        break;
                    } catch (err) {
                        if (i === retries - 1) throw err;
                        await new Promise(res => setTimeout(res, delay)); delay *= 2;
                    }
                }
                
                const jsonText = result.candidates[0].content.parts[0].text;
                const data = JSON.parse(jsonText);

                document.getElementById('ai-preview-best-team').innerText = data.bestFranchise;
                document.getElementById('ai-preview-analysis').innerText = data.analysis;
                
                const xiContainer = document.getElementById('ai-preview-xi');
                xiContainer.innerHTML = '';
                if (data.bestXI && data.bestXI.length > 0) {
                    data.bestXI.forEach(p => {
                        xiContainer.innerHTML += `
                            <div class="bg-zinc-950/50 border border-zinc-800 rounded-xl p-3 flex justify-between items-center shadow-inner hover:bg-zinc-900 transition-colors">
                                <div class="overflow-hidden pr-2">
                                    <h4 class="text-sm font-bold text-white truncate">${p.name}</h4>
                                    <p class="text-[9px] text-zinc-500 uppercase tracking-widest truncate">${p.role}</p>
                                </div>
                                <span class="bg-blue-900/30 text-blue-400 border border-blue-500/30 text-[9px] font-bold px-2 py-1 rounded truncate max-w-[100px] shrink-0">${p.franchise}</span>
                            </div>
                        `;
                    });
                }

                loading.classList.add('hidden'); loading.classList.remove('flex');
                content.classList.remove('hidden'); content.classList.add('flex');
            } catch (err) {
                console.error("AI Preview Error:", err);
                closeAIPreview();
                showToast("Tournament Preview is currently unavailable.");
            }
        };

        window.closeAIPreview = () => {
            const modal = document.getElementById('ai-preview-modal');
            modal.classList.add('opacity-0');
            modal.querySelector('.glass-panel').classList.add('scale-95');
            setTimeout(() => { 
                modal.classList.add('hidden'); 
                modal.classList.remove('flex'); 
                showFloatingButtons();
            }, 300);
        };

        function getGuestName() {
            try { return localStorage.getItem('cricbid_guest_name') || "Guest"; } catch(e) { return "Guest"; }
        }

        function setGuestName(name) {
            try { localStorage.setItem('cricbid_guest_name', name); } catch(e) {}
        }

        function clearGuestName() {
            try { localStorage.removeItem('cricbid_guest_name'); } catch(e) {}
        }

        const screens = { lobby: document.getElementById('lobby-screen'), auction: document.getElementById('auction-screen'), season: document.getElementById('season-screen') };
        const inputs = { roomCode: document.getElementById('room-code-input') };
        const buttons = { create: document.getElementById('btn-create-room'), join: document.getElementById('btn-join-room'), leave: document.getElementById('btn-leave') };
        const ui = {
            roomCode: document.getElementById('ui-room-code'),
            formatBadge: document.getElementById('ui-format-badge'),
            onlineCount: document.getElementById('ui-online-count'),
            myBudget: document.getElementById('ui-my-budget'),
            roomStatus: document.getElementById('ui-room-status'),
            timer: document.getElementById('ui-timer'),
            statusIndicator: document.getElementById('status-indicator'),
            playerCard: document.getElementById('player-card'),
            playerSet: document.getElementById('ui-player-set'),
            playerName: document.getElementById('ui-player-name'),
            playerRole: document.getElementById('ui-player-role'),
            playerCountry: document.getElementById('ui-player-country'),
            playerBase: document.getElementById('ui-player-base'),
            currentBid: document.getElementById('ui-current-bid'),
            highestBidder: document.getElementById('ui-highest-bidder'),
            biddingControls: document.getElementById('bidding-controls'),
            hostControls: document.getElementById('host-controls'),
            btnHostUnsold: document.getElementById('btn-host-unsold'),
            btnHostSkip: document.getElementById('btn-host-skip'),
            upcomingList: document.getElementById('upcoming-list'),
            standingsList: document.getElementById('standings-list'),
            soldOverlay: document.getElementById('sold-overlay')
        };
        const modalElements = {
            modal: document.getElementById('exit-modal'),
            content: document.getElementById('exit-modal-content'),
            cancel: document.getElementById('btn-cancel-exit'),
            confirm: document.getElementById('btn-confirm-exit')
        };

        window.showToast = (msg, actionHtml = '') => {
            const toast = document.getElementById('toast');
            document.getElementById('toast-msg').innerHTML = `<span class="block">${msg}</span>${actionHtml}`;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), actionHtml ? 8000 : 3500);
        };

        async function initAuth() {
            if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token && !auth.currentUser) {
                try {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } catch(e) { console.warn("Custom token failed", e); }
            }
        }
        initAuth();

        onAuthStateChanged(auth, async (user) => { 
            currentUser = user;
            if (user) {
                document.getElementById('login-section').classList.add('hidden');
                document.getElementById('guest-name-section').classList.add('hidden');
                document.getElementById('guest-name-section').classList.remove('flex');
                document.getElementById('auth-lobby-menu').classList.remove('hidden');
                document.getElementById('auth-lobby-menu').classList.add('flex');

                let displayName = user.displayName || getGuestName();
                let photoUrl = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=10b981&color=fff`;

                document.getElementById('user-display-name').innerText = displayName;
                document.getElementById('user-avatar').src = photoUrl;

                myPresenceId = user.uid;
                try {
                    await setDoc(doc(getPresenceRef(), myPresenceId), {
                        uid: user.uid,
                        name: displayName,
                        photo: photoUrl,
                        isOnline: true,
                        lastActive: Date.now()
                    });
                } catch(err) {
                    console.warn("Could not set presence (checking rules):", err);
                }

                listenToGlobalPresence();
                listenToInvites();

            } else {
                document.getElementById('login-section').classList.remove('hidden');
                document.getElementById('guest-name-section').classList.add('hidden');
                document.getElementById('guest-name-section').classList.remove('flex');
                document.getElementById('auth-lobby-menu').classList.add('hidden');
                document.getElementById('auth-lobby-menu').classList.remove('flex');
            }
        });

        document.getElementById('btn-google-login')?.addEventListener('click', async () => {
            try {
                const provider = new GoogleAuthProvider();
                await signInWithPopup(auth, provider);
            } catch(e) {
                console.warn("Google login blocked by Sandbox. Switching to Guest.");
                showToast("Sandbox domain blocked Google Login. Switching to Guest mode...");
                document.getElementById('btn-guest-login').click();
            }
        });

        document.getElementById('btn-guest-login')?.addEventListener('click', () => {
            document.getElementById('login-section').classList.add('hidden');
            document.getElementById('guest-name-section').classList.remove('hidden');
            document.getElementById('guest-name-section').classList.add('flex');
        });

        document.getElementById('btn-back-login')?.addEventListener('click', () => {
            document.getElementById('guest-name-section').classList.add('hidden');
            document.getElementById('guest-name-section').classList.remove('flex');
            document.getElementById('login-section').classList.remove('hidden');
        });

        document.getElementById('btn-confirm-guest')?.addEventListener('click', async () => {
            const name = document.getElementById('guest-name-input').value.trim();
            if (!name) return showToast("Enter an alias!");
            setGuestName(name);
            try {
                await signInAnonymously(auth);
            } catch(e) { console.error(e); showToast("Guest login failed."); }
        });

        let unsubPresence, unsubInvites, unsubscribeRooms, unsubscribeUsers, unsubscribePlayers, unsubscribeChat;
        
        function stopAllListeners() {
            if (unsubPresence) { unsubPresence(); unsubPresence = null; }
            if (unsubInvites) { unsubInvites(); unsubInvites = null; }
            if (unsubscribeRooms) { unsubscribeRooms(); unsubscribeRooms = null; }
            if (unsubscribeUsers) { unsubscribeUsers(); unsubscribeUsers = null; }
            if (unsubscribePlayers) { unsubscribePlayers(); unsubscribePlayers = null; }
            if (unsubscribeChat) { unsubscribeChat(); unsubscribeChat = null; }
            if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
            if (transferTimerInterval) { clearInterval(transferTimerInterval); transferTimerInterval = null; }
        }

        document.getElementById('btn-logout')?.addEventListener('click', async () => {
            try {
                if (myPresenceId && auth.currentUser) {
                    await updateDoc(doc(getPresenceRef(), myPresenceId), { isOnline: false });
                }
                stopAllListeners();
                await signOut(auth);
                clearGuestName();
                showToast("Signed out successfully.");
            } catch(e) { console.error("Sign out error", e); }
        });

        function listenToGlobalPresence() {
            if (unsubPresence) return;
            unsubPresence = onSnapshot(getPresenceRef(), (snapshot) => {
                globalPlayers = [];
                const now = Date.now();
                snapshot.forEach(docSnap => {
                    const data = docSnap.data();
                    if (data.uid !== currentUser?.uid && data.isOnline && (now - data.lastActive < 60000)) {
                        globalPlayers.push(data);
                    }
                });
                renderGlobalPlayers();
            });
        }

        function renderGlobalPlayers() {
            const container = document.getElementById('global-players-list');
            if (!container) return;
            container.innerHTML = '';
            
            const availablePlayers = globalPlayers.filter(p => !usersData.some(u => u.authId === p.uid && !u.kicked && !u.banned));
            
            if (availablePlayers.length === 0) {
                container.innerHTML = '<p class="text-xs text-zinc-600 italic px-1">No other players available to invite right now.</p>';
                return;
            }
            availablePlayers.forEach(p => {
                const isOnCooldown = inviteCooldowns[p.uid] && (Date.now() - inviteCooldowns[p.uid] < 5000);
                const btnText = isOnCooldown ? 'Invited' : 'Invite';
                const btnClass = isOnCooldown ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed border-zinc-600' : 'bg-cric-accent/20 text-blue-400 hover:bg-cric-accent/40 border-blue-500/30 active:scale-95';

                const div = document.createElement('div');
                div.className = "flex justify-between items-center bg-zinc-900 border border-zinc-800 p-2.5 rounded-xl";
                div.innerHTML = `
                    <div class="flex items-center gap-2">
                        <div class="w-2 h-2 rounded-full bg-cric-green shadow-[0_0_5px_#10b981]"></div>
                        <img src="${p.photo}" class="w-6 h-6 rounded-full border border-zinc-700">
                        <span class="text-xs font-bold text-zinc-300">${p.name}</span>
                    </div>
                    <button onclick="invitePlayer('${p.uid}', this)" class="text-[9px] px-3 py-1.5 rounded-lg transition-colors font-bold uppercase tracking-widest border ${btnClass}" ${isOnCooldown ? 'disabled' : ''}>${btnText}</button>
                `;
                container.appendChild(div);
            });
        }

        window.invitePlayer = async (targetUid, btnElement) => {
            if (!currentRoomId) return showToast("You must Host or Join a room first to send invites!");
            
            if (inviteCooldowns[targetUid] && (Date.now() - inviteCooldowns[targetUid] < 5000)) return;
            
            const myName = currentUser.displayName || getGuestName();
            try {
                inviteCooldowns[targetUid] = Date.now();
                
                if (btnElement) {
                    btnElement.disabled = true;
                    btnElement.innerText = 'Invited';
                    btnElement.className = 'text-[9px] px-3 py-1.5 rounded-lg transition-colors font-bold uppercase tracking-widest border bg-zinc-700 text-zinc-400 cursor-not-allowed border-zinc-600';
                    setTimeout(() => {
                        if (document.body.contains(btnElement)) {
                            btnElement.disabled = false;
                            btnElement.innerText = 'Invite';
                            btnElement.className = 'text-[9px] px-3 py-1.5 rounded-lg transition-colors font-bold uppercase tracking-widest border bg-cric-accent/20 text-blue-400 hover:bg-cric-accent/40 border-blue-500/30 active:scale-95';
                        }
                    }, 5000);
                }

                const invRef = doc(getInvitesRef());
                await setDoc(invRef, {
                    id: invRef.id,
                    fromName: myName,
                    toUid: targetUid,
                    roomId: currentRoomId,
                    timestamp: Date.now()
                });
                showToast("Invite sent successfully!");
            } catch(e) { console.error(e); }
        };

        function listenToInvites() {
            if (unsubInvites) return;
            unsubInvites = onSnapshot(getInvitesRef(), (snapshot) => {
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'added') {
                        const data = change.doc.data();
                        if (data.toUid === currentUser?.uid && Date.now() - data.timestamp < 30000) {
                            showToast(
                                `${data.fromName} invited you to play!`, 
                                `<div class="flex gap-2 mt-2 w-full">
                                    <button onclick="acceptInvite('${data.roomId}')" class="flex-1 bg-white hover:bg-zinc-200 text-zinc-900 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest shadow-md transition-colors">Join</button>
                                    <button onclick="rejectInvite()" class="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest border border-zinc-700 transition-colors">Reject</button>
                                </div>`
                            );
                        }
                    }
                });
            });
        }

        window.acceptInvite = async (roomId) => {
            document.getElementById('toast').classList.remove('show');
            document.getElementById('room-code-input').value = roomId;
            document.getElementById('btn-join-room').click();
        };

        window.rejectInvite = () => {
            document.getElementById('toast').classList.remove('show');
        };

        window.openInviteModal = () => {
            hideFloatingButtons();
            const modal = document.getElementById('invite-modal');
            const codeInput = document.getElementById('invite-code-display');
            if (codeInput) codeInput.value = currentRoomId;
            modal.classList.remove('hidden');
            setTimeout(() => { 
                modal.classList.remove('opacity-0'); 
                modal.querySelector('.glass-panel').classList.remove('scale-95'); 
            }, 10);
        };

        window.closeInviteModal = () => {
            const modal = document.getElementById('invite-modal');
            modal.classList.add('opacity-0');
            modal.querySelector('.glass-panel').classList.add('scale-95');
            setTimeout(() => { 
                modal.classList.add('hidden');
                showFloatingButtons();
            }, 300);
        };

        window.copyRoomCode = () => {
            const el = document.getElementById('invite-code-display');
            el.select();
            document.execCommand('copy');
            showToast("Room code copied to clipboard!");
        };

        const formatMoney = (val) => val.toFixed(2);
        const generateRoomCode = () => {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let result = '';
            for (let i = 0; i < 6; i++) { result += chars.charAt(Math.floor(Math.random() * chars.length)); }
            return result;
        };

        const BUDGET_DEFAULT = 120.0;
        const TIMER_SECONDS = 15;
        
        // Mock dataset added to ensure the auction works out of the box when testing in preview
        const AUCTION_DATABASES = {
            "T20": [
                { name: "Jasprit Bumrah", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Virat Kohli", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Suryakumar Yadav", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Hardik Pandya", role: "All-Rounder", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Rashid Khan", role: "Bowler", country: "AFG", base: 2.0, set: "Marquee" },
{ name: "Travis Head", role: "Batsman", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Heinrich Klaasen", role: "Wicket Keeper", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Jos Buttler", role: "Wicket Keeper", country: "ENG", base: 2.0, set: "Marquee" },
{ name: "Sunil Narine", role: "All-Rounder", country: "WI", base: 2.0, set: "Marquee" },
{ name: "Nicholas Pooran", role: "Wicket Keeper", country: "WI", base: 2.0, set: "Marquee" },
{ name: "Shubman Gill", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Yashasvi Jaiswal", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Pat Cummins", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Mitchell Starc", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Phil Salt", role: "Wicket Keeper", country: "ENG", base: 2.0, set: "Marquee" },
{ name: "Andre Russell", role: "All-Rounder", country: "WI", base: 2.0, set: "Marquee" },
{ name: "Ravindra Jadeja", role: "All-Rounder", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Cameron Green", role: "All-Rounder", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Kagiso Rabada", role: "Bowler", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Varun Chakravarthy", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Kuldeep Yadav", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Rohit Sharma", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Mitchell Marsh", role: "All-Rounder", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Josh Hazlewood", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Yuzvendra Chahal", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },

// =====================
// BATSMEN
// =====================

{ name: "Sai Sudharsan", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Ruturaj Gaikwad", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Tilak Varma", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Abhishek Sharma", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Shreyas Iyer", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Rinku Singh", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Rajat Patidar", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Priyansh Arya", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Vaibhav Sooryavanshi", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Nehal Wadhera", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Ayush Badoni", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Ashutosh Sharma", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Rahul Tripathi", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Devdutt Padikkal", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Angkrish Raghuvanshi", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Sameer Rizvi", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Aniket Verma", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Karun Nair", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Abhinav Manohar", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Shashank Singh", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Dhruv Shorey", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Harnoor Singh", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "David Warner", role: "Batsman", country: "AUS", base: 1.5, set: "Batsmen" },
{ name: "David Miller", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Glenn Phillips", role: "Batsman", country: "NZ", base: 1.5, set: "Batsmen" },
{ name: "Harry Brook", role: "Batsman", country: "ENG", base: 1.5, set: "Batsmen" },
{ name: "Aiden Markram", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Rassie van der Dussen", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Jake Fraser-McGurk", role: "Batsman", country: "AUS", base: 1.5, set: "Batsmen" },
{ name: "Dewald Brevis", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Faf du Plessis", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Tristan Stubbs", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Brandon King", role: "Batsman", country: "WI", base: 1.5, set: "Batsmen" },
{ name: "Rovman Powell", role: "Batsman", country: "WI", base: 1.5, set: "Batsmen" },
{ name: "Tim David", role: "Batsman", country: "AUS", base: 1.5, set: "Batsmen" },
{ name: "Pathum Nissanka", role: "Batsman", country: "SL", base: 1.5, set: "Batsmen" },
{ name: "Charith Asalanka", role: "Batsman", country: "SL", base: 1.5, set: "Batsmen" },
{ name: "Ibrahim Zadran", role: "Batsman", country: "AFG", base: 1.5, set: "Batsmen" },
{ name: "Finn Allen", role: "Batsman", country: "NZ", base: 1.5, set: "Batsmen" },
{ name: "Ben Duckett", role: "Batsman", country: "ENG", base: 1.5, set: "Batsmen" },
{ name: "Dawid Malan", role: "Batsman", country: "ENG", base: 1.5, set: "Batsmen" },
{ name: "Tom Kohler-Cadmore", role: "Batsman", country: "ENG", base: 1.5, set: "Batsmen" },
{ name: "Matthew Short", role: "Batsman", country: "AUS", base: 1.5, set: "Batsmen" },
{ name: "Daryl Mitchell", role: "Batsman", country: "NZ", base: 1.5, set: "Batsmen" },

// =====================
// BOWLERS
// =====================

// PACERS
// =====================
// PACERS
// =====================

{ name: "Mohammed Shami", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Mohammed Siraj", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Arshdeep Singh", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Prasidh Krishna", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Bhuvneshwar Kumar", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "T Natarajan", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Harshit Rana", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Mayank Yadav", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Avesh Khan", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Khaleel Ahmed", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Yash Dayal", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Mukesh Kumar", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Akash Deep", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Deepak Chahar", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Mohsin Khan", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Sandeep Sharma", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Umran Malik", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Vaibhav Arora", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Vijaykumar Vyshak", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Simarjeet Singh", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Ashwani Kumar", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Prince Yadav", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Sakib Hussain", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Praful Hinge", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Anshul Kamboj", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Mustafizur Rahman", role: "Bowler", country: "BAN", base: 1.5, set: "Pacers" },
{ name: "Matheesha Pathirana", role: "Bowler", country: "SL", base: 1.5, set: "Pacers" },
{ name: "Jofra Archer", role: "Bowler", country: "ENG", base: 1.5, set: "Pacers" },
{ name: "Trent Boult", role: "Bowler", country: "NZ", base: 1.5, set: "Pacers" },
{ name: "Lockie Ferguson", role: "Bowler", country: "NZ", base: 1.5, set: "Pacers" },
{ name: "Gerald Coetzee", role: "Bowler", country: "SA", base: 1.5, set: "Pacers" },
{ name: "Nandre Burger", role: "Bowler", country: "SA", base: 1.5, set: "Pacers" },
{ name: "Spencer Johnson", role: "Bowler", country: "AUS", base: 1.5, set: "Pacers" },
{ name: "Anrich Nortje", role: "Bowler", country: "SA", base: 1.5, set: "Pacers" },
{ name: "Lungi Ngidi", role: "Bowler", country: "SA", base: 1.5, set: "Pacers" },
{ name: "Alzarri Joseph", role: "Bowler", country: "WI", base: 1.5, set: "Pacers" },
{ name: "Matt Henry", role: "Bowler", country: "NZ", base: 1.5, set: "Pacers" },
{ name: "Taskin Ahmed", role: "Bowler", country: "BAN", base: 1.5, set: "Pacers" },
{ name: "Dushmantha Chameera", role: "Bowler", country: "SL", base: 1.5, set: "Pacers" },

// =====================
// SPINNERS
// =====================

{ name: "Ravi Bishnoi", role: "Bowler", country: "IND", base: 1.5, set: "Spinners" },
{ name: "Sai Kishore", role: "Bowler", country: "IND", base: 1.5, set: "Spinners" },
{ name: "Noor Ahmad", role: "Bowler", country: "AFG", base: 1.5, set: "Spinners" },
{ name: "Maheesh Theekshana", role: "Bowler", country: "SL", base: 1.5, set: "Spinners" },
{ name: "Adam Zampa", role: "Bowler", country: "AUS", base: 1.5, set: "Spinners" },
{ name: "Adil Rashid", role: "Bowler", country: "ENG", base: 1.5, set: "Spinners" },
{ name: "Mujeeb Ur Rahman", role: "Bowler", country: "AFG", base: 1.5, set: "Spinners" },
{ name: "Gudakesh Motie", role: "Bowler", country: "WI", base: 1.5, set: "Spinners" },
{ name: "Ish Sodhi", role: "Bowler", country: "NZ", base: 1.5, set: "Spinners" },
{ name: "Keshav Maharaj", role: "Bowler", country: "SA", base: 1.5, set: "Spinners" },

// =====================
// WICKET KEEPERS
// =====================

// =====================
// WICKETKEEPERS
// =====================

{ name: "Rishabh Pant", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Sanju Samson", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "KL Rahul", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Ishan Kishan", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Dhruv Jurel", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Jitesh Sharma", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Prabhsimran Singh", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Robin Minz", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Urvil Patel", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Vishnu Vinod", role: "Wicket Keeper", country: "IND", base: 1.5, set: "Wicketkeepers" },

{ name: "Quinton de Kock", role: "Wicket Keeper", country: "SA", base: 1.5, set: "Wicketkeepers" },
{ name: "Ryan Rickelton", role: "Wicket Keeper", country: "SA", base: 1.5, set: "Wicketkeepers" },
{ name: "Devon Conway", role: "Wicket Keeper", country: "NZ", base: 1.5, set: "Wicketkeepers" },
{ name: "Josh Inglis", role: "Wicket Keeper", country: "AUS", base: 1.5, set: "Wicketkeepers" },
{ name: "Kusal Mendis", role: "Wicket Keeper", country: "SL", base: 1.5, set: "Wicketkeepers" },

{ name: "Mohammad Rizwan", role: "Wicket Keeper", country: "PAK", base: 1.5, set: "Wicketkeepers" },
{ name: "Rahmanullah Gurbaz", role: "Wicket Keeper", country: "AFG", base: 1.5, set: "Wicketkeepers" },
{ name: "Tim Seifert", role: "Wicket Keeper", country: "NZ", base: 1.5, set: "Wicketkeepers" },
{ name: "Tom Banton", role: "Wicket Keeper", country: "ENG", base: 1.5, set: "Wicketkeepers" },
{ name: "Alex Carey", role: "Wicket Keeper", country: "AUS", base: 1.5, set: "Wicketkeepers" },

{ name: "Kusal Perera", role: "Wicket Keeper", country: "SL", base: 1.5, set: "Wicketkeepers" },
{ name: "Litton Das", role: "Wicket Keeper", country: "BAN", base: 1.5, set: "Wicketkeepers" },
{ name: "Ben McDermott", role: "Wicket Keeper", country: "AUS", base: 1.5, set: "Wicketkeepers" },
{ name: "Tom Latham", role: "Wicket Keeper", country: "NZ", base: 1.5, set: "Wicketkeepers" },
{ name: "Jamie Smith", role: "Wicket Keeper", country: "ENG", base: 1.5, set: "Wicketkeepers" },

// =====================
// ALL-ROUNDERS
// =====================

{ name: "Axar Patel", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Krunal Pandya", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Washington Sundar", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Shivam Dube", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Venkatesh Iyer", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },

{ name: "Riyan Parag", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Nitish Kumar Reddy", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Ramandeep Singh", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Rahul Tewatia", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Harpreet Brar", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },

{ name: "Shahbaz Ahmed", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Swapnil Singh", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Raj Bawa", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Vipraj Nigam", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Nishant Sindhu", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },

{ name: "Arshin Kulkarni", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Musheer Khan", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Suryansh Shedge", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Naman Dhir", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Anukul Roy", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },

{ name: "Manoj Bhandage", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Ramakrishna Ghosh", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Prashant Veer", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Arjun Tendulkar", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Darshan Nalkande", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },

{ name: "Arshad Khan", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Ajay Mandal", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Manav Suthar", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Madhav Tiwari", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Yuvraj Choudhary", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },

{ name: "Glenn Maxwell", role: "All-Rounder", country: "AUS", base: 1.5, set: "All-Rounders" },
{ name: "Marcus Stoinis", role: "All-Rounder", country: "AUS", base: 1.5, set: "All-Rounders" },
{ name: "Liam Livingstone", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Moeen Ali", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Sam Curran", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },

{ name: "Romario Shepherd", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounders" },
{ name: "Sikandar Raza", role: "All-Rounder", country: "ZIM", base: 1.5, set: "All-Rounders" },
{ name: "Azmatullah Omarzai", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounders" },
{ name: "Marco Jansen", role: "All-Rounder", country: "SA", base: 1.5, set: "All-Rounders" },
{ name: "Wanindu Hasaranga", role: "All-Rounder", country: "SL", base: 1.5, set: "All-Rounders" },

{ name: "Mitchell Santner", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounders" },
{ name: "Michael Bracewell", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounders" },
{ name: "Roston Chase", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounders" },
{ name: "Mohammad Nabi", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounders" },
{ name: "Shakib Al Hasan", role: "All-Rounder", country: "BAN", base: 1.5, set: "All-Rounders" },

{ name: "Akeal Hosein", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounders" },
{ name: "Karim Janat", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounders" },
{ name: "Sherfane Rutherford", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounders" },
{ name: "Wiaan Mulder", role: "All-Rounder", country: "SA", base: 1.5, set: "All-Rounders" },
{ name: "Corbin Bosch", role: "All-Rounder", country: "SA", base: 1.5, set: "All-Rounders" },

{ name: "Rachin Ravindra", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounders" },
{ name: "Will Jacks", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Jacob Bethell", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Kamindu Mendis", role: "All-Rounder", country: "SL", base: 1.5, set: "All-Rounders" },
{ name: "Jamie Overton", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },

{ name: "Brydon Carse", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Matthew Forde", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounders" },
{ name: "Gerhard Erasmus", role: "All-Rounder", country: "NAM", base: 1.5, set: "All-Rounders" },
{ name: "Dipendra Singh Airee", role: "All-Rounder", country: "NEP", base: 1.5, set: "All-Rounders" },
{ name: "Bas de Leede", role: "All-Rounder", country: "NED", base: 1.5, set: "All-Rounders" }
            ],
            "ODI": [
                { name: "Virat Kohli", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Rohit Sharma", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Shubman Gill", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Travis Head", role: "Batsman", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Steve Smith", role: "Batsman", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Kane Williamson", role: "Batsman", country: "NZ", base: 2.0, set: "Marquee" },
{ name: "Joe Root", role: "Batsman", country: "ENG", base: 2.0, set: "Marquee" },
{ name: "Heinrich Klaasen", role: "Batsman", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Rassie van der Dussen", role: "Batsman", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Pathum Nissanka", role: "Batsman", country: "SL", base: 2.0, set: "Marquee" },

{ name: "Jos Buttler", role: "Wicketkeeper", country: "ENG", base: 2.0, set: "Marquee" },
{ name: "Mohammad Rizwan", role: "Wicketkeeper", country: "PAK", base: 2.0, set: "Marquee" },
{ name: "Quinton de Kock", role: "Wicketkeeper", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Nicholas Pooran", role: "Wicketkeeper", country: "WI", base: 2.0, set: "Marquee" },

{ name: "Hardik Pandya", role: "All-Rounder", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Ravindra Jadeja", role: "All-Rounder", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Mitchell Marsh", role: "All-Rounder", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Marco Jansen", role: "All-Rounder", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Glenn Maxwell", role: "All-Rounder", country: "AUS", base: 2.0, set: "Marquee" },

{ name: "Jasprit Bumrah", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Mohammed Shami", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Pat Cummins", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Mitchell Starc", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Kagiso Rabada", role: "Bowler", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Kuldeep Yadav", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },

// BATTERS

{ name: "Yashasvi Jaiswal", role: "Batsman", country: "IND", base: 1.5, set: "Batsman" },
{ name: "Sai Sudharsan", role: "Batsman", country: "IND", base: 1.5, set: "Batsman" },
{ name: "Shreyas Iyer", role: "Batsman", country: "IND", base: 1.5, set: "Batsman" },
{ name: "Ruturaj Gaikwad", role: "Batsman", country: "IND", base: 1.5, set: "Batsman" },
{ name: "Tilak Varma", role: "Batsman", country: "IND", base: 1.5, set: "Batsman" },
{ name: "Rajat Patidar", role: "Batsman", country: "IND", base: 1.0, set: "Batsman" },
{ name: "Sarfaraz Khan", role: "Batsman", country: "IND", base: 1.0, set: "Batsman" },
{ name: "Harry Brook", role: "Batsman", country: "ENG", base: 1.5, set: "Batsman" },
{ name: "Ben Duckett", role: "Batsman", country: "ENG", base: 1.0, set: "Batsman" },
{ name: "Zak Crawley", role: "Batsman", country: "ENG", base: 1.0, set: "Batsman" },
{ name: "Dawid Malan", role: "Batsman", country: "ENG", base: 1.0, set: "Batsman" },
{ name: "Ollie Pope", role: "Batsman", country: "ENG", base: 1.0, set: "Batsman" },
{ name: "Marnus Labuschagne", role: "Batsman", country: "AUS", base: 1.5, set: "Batsman" },
{ name: "Cameron Bancroft", role: "Batsman", country: "AUS", base: 0.5, set: "Batsman" },
{ name: "Aiden Markram", role: "Batsman", country: "SA", base: 1.5, set: "Batsman" },
{ name: "David Miller", role: "Batsman", country: "SA", base: 1.5, set: "Batsman" },
{ name: "Temba Bavuma", role: "Batsman", country: "SA", base: 1.0, set: "Batsman" },
{ name: "Tony de Zorzi", role: "Batsman", country: "SA", base: 0.5, set: "Batsman" },
{ name: "Ryan Rickelton", role: "Batsman", country: "SA", base: 1.0, set: "Batsman" },
{ name: "Devon Conway", role: "Batsman", country: "NZ", base: 1.5, set: "Batsman" },
{ name: "Daryl Mitchell", role: "Batsman", country: "NZ", base: 1.5, set: "Batsman" },
{ name: "Will Young", role: "Batsman", country: "NZ", base: 1.0, set: "Batsman" },
{ name: "Mark Chapman", role: "Batsman", country: "NZ", base: 1.0, set: "Batsman" },
{ name: "Fakhar Zaman", role: "Batsman", country: "PAK", base: 1.5, set: "Batsman" },
{ name: "Abdullah Shafique", role: "Batsman", country: "PAK", base: 1.0, set: "Batsman" },
{ name: "Imam-ul-Haq", role: "Batsman", country: "PAK", base: 1.0, set: "Batsman" },
{ name: "Ibrahim Zadran", role: "Batsman", country: "AFG", base: 1.0, set: "Batsman" },
{ name: "Charith Asalanka", role: "Batsman", country: "SL", base: 1.0, set: "Batsman" },
{ name: "Avishka Fernando", role: "Batsman", country: "SL", base: 0.5, set: "Batsman" },
{ name: "Towhid Hridoy", role: "Batsman", country: "BAN", base: 0.5, set: "Batsman" },
{ name: "Litton Das", role: "Batsman", country: "BAN", base: 1.0, set: "Batsman" },
{ name: "Najmul Hossain Shanto", role: "Batsman", country: "BAN", base: 1.0, set: "Batsman" },
{ name: "Brandon King", role: "Batsman", country: "WI", base: 1.0, set: "Batsman" },
{ name: "Keacy Carty", role: "Batsman", country: "WI", base: 0.5, set: "Batsman" },
{ name: "Paul Stirling", role: "Batsman", country: "IRE", base: 1.0, set: "Batsman" },
{ name: "Andy Balbirnie", role: "Batsman", country: "IRE", base: 0.5, set: "Batsman" },
{ name: "Max O'Dowd", role: "Batsman", country: "NED", base: 0.5, set: "Batsman" },
{ name: "Nitish Rana", role: "Batsman", country: "IND", base: 0.5, set: "Batsman" },
{ name: "Finn Allen", role: "Batsman", country: "NZ", base: 1.0, set: "Batsman" },
{ name: "Nuwanidu Fernando", role: "Batsman", country: "SL", base: 0.5, set: "Batsman" },
{ name: "Rinku Singh", role: "Batsman", country: "IND", base: 1.0, set: "Batsman" },
{ name: "Angkrish Raghuvanshi", role: "Batsman", country: "IND", base: 0.5, set: "Batsman" },
{ name: "Dewald Brevis", role: "Batsman", country: "SA", base: 1.0, set: "Batsman" },
{ name: "Babar Azam", role: "Batsman", country: "PAK", base: 2.0, set: "Batsman" },
{ name: "Saim Ayub", role: "Batsman", country: "PAK", base: 1.0, set: "Batsman" },
{ name: "Rahmat Shah", role: "Batsman", country: "AFG", base: 1.0, set: "Batsman" },
{ name: "Kusal Perera", role: "Batsman", country: "SL", base: 1.0, set: "Batsman" },
{ name: "Rilee Rossouw", role: "Batsman", country: "SA", base: 1.0, set: "Batsman" },
{ name: "Tom Banton", role: "Batsman", country: "ENG", base: 0.5, set: "Batsman" },
{ name: "Jonathan Campbell", role: "Batsman", country: "ZIM", base: 0.5, set: "Batsman" },

// WICKETKEEPERS

{ name: "KL Rahul", role: "Wicketkeeper", country: "IND", base: 1.5, set: "Wicketkeeper" },
{ name: "Rishabh Pant", role: "Wicketkeeper", country: "IND", base: 1.5, set: "Wicketkeeper" },
{ name: "Sanju Samson", role: "Wicketkeeper", country: "IND", base: 1.5, set: "Wicketkeeper" },
{ name: "Ishan Kishan", role: "Wicketkeeper", country: "IND", base: 1.0, set: "Wicketkeeper" },
{ name: "Dhruv Jurel", role: "Wicketkeeper", country: "IND", base: 1.0, set: "Wicketkeeper" },
{ name: "Tom Latham", role: "Wicketkeeper", country: "NZ", base: 1.0, set: "Wicketkeeper" },
{ name: "Kusal Mendis", role: "Wicketkeeper", country: "SL", base: 1.0, set: "Wicketkeeper" },
{ name: "Rahmanullah Gurbaz", role: "Wicketkeeper", country: "AFG", base: 1.0, set: "Wicketkeeper" },
{ name: "Mohammad Haris", role: "Wicketkeeper", country: "PAK", base: 0.5, set: "Wicketkeeper" },
{ name: "Sadeera Samarawickrama", role: "Wicketkeeper", country: "SL", base: 0.5, set: "Wicketkeeper" },
{ name: "Josh Inglis", role: "Wicketkeeper", country: "AUS", base: 1.0, set: "Wicketkeeper" },
{ name: "Alex Carey", role: "Wicketkeeper", country: "AUS", base: 1.0, set: "Wicketkeeper" },
{ name: "Jamie Smith", role: "Wicketkeeper", country: "ENG", base: 1.0, set: "Wicketkeeper" },
{ name: "Ben Foakes", role: "Wicketkeeper", country: "ENG", base: 0.5, set: "Wicketkeeper" },
{ name: "Kyle Verreynne", role: "Wicketkeeper", country: "SA", base: 1.0, set: "Wicketkeeper" },
{ name: "Shai Hope", role: "Wicketkeeper", country: "WI", base: 1.5, set: "Wicketkeeper" },
{ name: "Scott Edwards", role: "Wicketkeeper", country: "NED", base: 0.5, set: "Wicketkeeper" },
{ name: "Jitesh Sharma", role: "Wicketkeeper", country: "IND", base: 0.5, set: "Wicketkeeper" },
{ name: "Devon Thomas", role: "Wicketkeeper", country: "WI", base: 0.5, set: "Wicketkeeper" },
{ name: "Phil Salt", role: "Wicketkeeper", country: "ENG", base: 1.5, set: "Wicketkeeper" },
{ name: "Mushfiqur Rahim", role: "Wicketkeeper", country: "BAN", base: 1.0, set: "Wicketkeeper" },
{ name: "Dinesh Chandimal", role: "Wicketkeeper", country: "SL", base: 1.0, set: "Wicketkeeper" },
{ name: "Johnson Charles", role: "Wicketkeeper", country: "WI", base: 0.5, set: "Wicketkeeper" },
{ name: "Matthew Short", role: "Wicketkeeper", country: "AUS", base: 1.0, set: "Wicketkeeper" },

// BOWLERS

{ name: "Mohammed Siraj", role: "Bowler", country: "IND", base: 1.5, set: "Pacer" },
{ name: "Arshdeep Singh", role: "Bowler", country: "IND", base: 1.5, set: "Pacer" },
{ name: "Prasidh Krishna", role: "Bowler", country: "IND", base: 1.0, set: "Pacer" },
{ name: "Harshit Rana", role: "Bowler", country: "IND", base: 1.0, set: "Pacer" },
{ name: "Akash Deep", role: "Bowler", country: "IND", base: 1.0, set: "Pacer" },
{ name: "Mukesh Kumar", role: "Bowler", country: "IND", base: 0.5, set: "Pacer" },
{ name: "T Natarajan", role: "Bowler", country: "IND", base: 1.0, set: "Pacer" },
{ name: "Avesh Khan", role: "Bowler", country: "IND", base: 0.5, set: "Pacer" },
{ name: "Josh Hazlewood", role: "Bowler", country: "AUS", base: 1.5, set: "Pacer" },
{ name: "Nathan Ellis", role: "Bowler", country: "AUS", base: 1.0, set: "Pacer" },
{ name: "Spencer Johnson", role: "Bowler", country: "AUS", base: 1.0, set: "Pacer" },
{ name: "Matt Henry", role: "Bowler", country: "NZ", base: 1.5, set: "Pacer" },
{ name: "Lockie Ferguson", role: "Bowler", country: "NZ", base: 1.5, set: "Pacer" },
{ name: "Will O'Rourke", role: "Bowler", country: "NZ", base: 1.0, set: "Pacer" },
{ name: "Ben Sears", role: "Bowler", country: "NZ", base: 1.0, set: "Pacer" },
{ name: "Anrich Nortje", role: "Bowler", country: "SA", base: 1.5, set: "Pacer" },
{ name: "Lungi Ngidi", role: "Bowler", country: "SA", base: 1.0, set: "Pacer" },
{ name: "Shaheen Afridi", role: "Bowler", country: "PAK", base: 1.5, set: "Pacer" },
{ name: "Naseem Shah", role: "Bowler", country: "PAK", base: 1.5, set: "Pacer" },
{ name: "Haris Rauf", role: "Bowler", country: "PAK", base: 1.5, set: "Pacer" },
{ name: "Dilshan Madushanka", role: "Bowler", country: "SL", base: 1.0, set: "Pacer" },
{ name: "Taskin Ahmed", role: "Bowler", country: "BAN", base: 1.0, set: "Pacer" },
{ name: "Mustafizur Rahman", role: "Bowler", country: "BAN", base: 1.0, set: "Pacer" },
{ name: "Tanzim Hasan Sakib", role: "Bowler", country: "BAN", base: 0.5, set: "Pacer" },
{ name: "Alzarri Joseph", role: "Bowler", country: "WI", base: 1.0, set: "Pacer" },
{ name: "Mark Wood", role: "Bowler", country: "ENG", base: 1.5, set: "Pacer" },
{ name: "Gus Atkinson", role: "Bowler", country: "ENG", base: 1.0, set: "Pacer" },
{ name: "Reece Topley", role: "Bowler", country: "ENG", base: 1.0, set: "Pacer" },
{ name: "Naveen-ul-Haq", role: "Bowler", country: "AFG", base: 1.0, set: "Pacer" },
{ name: "Fazalhaq Farooqi", role: "Bowler", country: "AFG", base: 1.0, set: "Pacer" },
{ name: "Blessing Muzarabani", role: "Bowler", country: "ZIM", base: 1.0, set: "Pacer" },
{ name: "Richard Ngarava", role: "Bowler", country: "ZIM", base: 0.5, set: "Pacer" },
{ name: "Paul van Meekeren", role: "Bowler", country: "NED", base: 0.5, set: "Pacer" },

{ name: "Adam Zampa", role: "Bowler", country: "AUS", base: 1.5, set: "Spinner" },
{ name: "Keshav Maharaj", role: "Bowler", country: "SA", base: 1.0, set: "Spinner" },
{ name: "Tabraiz Shamsi", role: "Bowler", country: "SA", base: 1.0, set: "Spinner" },
{ name: "Abrar Ahmed", role: "Bowler", country: "PAK", base: 1.0, set: "Spinner" },
{ name: "Maheesh Theekshana", role: "Bowler", country: "SL", base: 1.0, set: "Spinner" },
{ name: "Wanindu Hasaranga", role: "Bowler", country: "SL", base: 1.5, set: "Spinner" },
{ name: "Jeffrey Vandersay", role: "Bowler", country: "SL", base: 0.5, set: "Spinner" },
{ name: "Gudakesh Motie", role: "Bowler", country: "WI", base: 0.5, set: "Spinner" },
{ name: "Akeal Hosein", role: "Bowler", country: "WI", base: 0.5, set: "Spinner" },
{ name: "Adil Rashid", role: "Bowler", country: "ENG", base: 1.0, set: "Spinner" },
{ name: "Mujeeb Ur Rahman", role: "Bowler", country: "AFG", base: 1.0, set: "Spinner" },

// ALL-ROUNDERS

{ name: "Axar Patel", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounder" },
{ name: "Washington Sundar", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounder" },
{ name: "Nitish Kumar Reddy", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounder" },
{ name: "Shivam Dube", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounder" },
{ name: "Riyan Parag", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounder" },
{ name: "Sam Curran", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounder" },
{ name: "Liam Livingstone", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounder" },
{ name: "Jacob Bethell", role: "All-Rounder", country: "ENG", base: 1.0, set: "All-Rounder" },
{ name: "Michael Bracewell", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounder" },
{ name: "Rachin Ravindra", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounder" },
{ name: "Mitchell Santner", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounder" },
{ name: "Glenn Phillips", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounder" },
{ name: "Marcus Stoinis", role: "All-Rounder", country: "AUS", base: 1.5, set: "All-Rounder" },
{ name: "Cameron Green", role: "All-Rounder", country: "AUS", base: 1.5, set: "All-Rounder" },
{ name: "Aaron Hardie", role: "All-Rounder", country: "AUS", base: 1.0, set: "All-Rounder" },
{ name: "Sikandar Raza", role: "All-Rounder", country: "ZIM", base: 1.5, set: "All-Rounder" },
{ name: "Sean Williams", role: "All-Rounder", country: "ZIM", base: 1.0, set: "All-Rounder" },
{ name: "Mehidy Hasan Miraz", role: "All-Rounder", country: "BAN", base: 1.5, set: "All-Rounder" },
{ name: "Mahmudullah", role: "All-Rounder", country: "BAN", base: 1.0, set: "All-Rounder" },
{ name: "Azmatullah Omarzai", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounder" },
{ name: "Mohammad Nabi", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounder" },
{ name: "Sherfane Rutherford", role: "All-Rounder", country: "WI", base: 1.0, set: "All-Rounder" },
{ name: "Roston Chase", role: "All-Rounder", country: "WI", base: 1.0, set: "All-Rounder" },
{ name: "Gerhard Erasmus", role: "All-Rounder", country: "NAM", base: 1.0, set: "All-Rounder" },
{ name: "Bas de Leede", role: "All-Rounder", country: "NED", base: 1.0, set: "All-Rounder" },
{ name: "Shakib Al Hasan", role: "All-Rounder", country: "BAN", base: 2.0, set: "All-Rounder" },
{ name: "Moeen Ali", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounder" },
{ name: "Jimmy Neesham", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounder" },
{ name: "Kyle Jamieson", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounder" },
{ name: "Jason Holder", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounder" },
{ name: "Romario Shepherd", role: "All-Rounder", country: "WI", base: 1.0, set: "All-Rounder" },
{ name: "Odean Smith", role: "All-Rounder", country: "WI", base: 0.5, set: "All-Rounder" },
{ name: "Dhananjaya de Silva", role: "All-Rounder", country: "SL", base: 1.0, set: "All-Rounder" },
{ name: "Chamika Karunaratne", role: "All-Rounder", country: "SL", base: 0.5, set: "All-Rounder" }

            ],
            "TEST": [
                { name: "Virat Kohli", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Rohit Sharma", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Shubman Gill", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Travis Head", role: "Batsman", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Steve Smith", role: "Batsman", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Kane Williamson", role: "Batsman", country: "NZ", base: 2.0, set: "Marquee" },
{ name: "Joe Root", role: "Batsman", country: "ENG", base: 2.0, set: "Marquee" },
{ name: "Heinrich Klaasen", role: "Batsman", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Rassie van der Dussen", role: "Batsman", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Pathum Nissanka", role: "Batsman", country: "SL", base: 2.0, set: "Marquee" },

{ name: "Jos Buttler", role: "Wicketkeeper", country: "ENG", base: 2.0, set: "Marquee" },
{ name: "Mohammad Rizwan", role: "Wicketkeeper", country: "PAK", base: 2.0, set: "Marquee" },
{ name: "Quinton de Kock", role: "Wicketkeeper", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Nicholas Pooran", role: "Wicketkeeper", country: "WI", base: 2.0, set: "Marquee" },

{ name: "Hardik Pandya", role: "All-Rounder", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Ravindra Jadeja", role: "All-Rounder", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Mitchell Marsh", role: "All-Rounder", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Marco Jansen", role: "All-Rounder", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Glenn Maxwell", role: "All-Rounder", country: "AUS", base: 2.0, set: "Marquee" },

{ name: "Jasprit Bumrah", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Mohammed Shami", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },
{ name: "Pat Cummins", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Mitchell Starc", role: "Bowler", country: "AUS", base: 2.0, set: "Marquee" },
{ name: "Kagiso Rabada", role: "Bowler", country: "SA", base: 2.0, set: "Marquee" },
{ name: "Kuldeep Yadav", role: "Bowler", country: "IND", base: 2.0, set: "Marquee" },

{ name: "Yashasvi Jaiswal", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Sai Sudharsan", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Shreyas Iyer", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Ruturaj Gaikwad", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Tilak Varma", role: "Batsman", country: "IND", base: 1.5, set: "Batsmen" },
{ name: "Rajat Patidar", role: "Batsman", country: "IND", base: 1.0, set: "Batsmen" },
{ name: "Sarfaraz Khan", role: "Batsman", country: "IND", base: 1.0, set: "Batsmen" },
{ name: "Harry Brook", role: "Batsman", country: "ENG", base: 1.5, set: "Batsmen" },
{ name: "Ben Duckett", role: "Batsman", country: "ENG", base: 1.0, set: "Batsmen" },
{ name: "Zak Crawley", role: "Batsman", country: "ENG", base: 1.0, set: "Batsmen" },
{ name: "Dawid Malan", role: "Batsman", country: "ENG", base: 1.0, set: "Batsmen" },
{ name: "Ollie Pope", role: "Batsman", country: "ENG", base: 1.0, set: "Batsmen" },
{ name: "Marnus Labuschagne", role: "Batsman", country: "AUS", base: 1.5, set: "Batsmen" },
{ name: "Cameron Bancroft", role: "Batsman", country: "AUS", base: 0.5, set: "Batsmen" },
{ name: "Aiden Markram", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "David Miller", role: "Batsman", country: "SA", base: 1.5, set: "Batsmen" },
{ name: "Temba Bavuma", role: "Batsman", country: "SA", base: 1.0, set: "Batsmen" },
{ name: "Tony de Zorzi", role: "Batsman", country: "SA", base: 0.5, set: "Batsmen" },
{ name: "Ryan Rickelton", role: "Batsman", country: "SA", base: 1.0, set: "Batsmen" },
{ name: "Devon Conway", role: "Batsman", country: "NZ", base: 1.5, set: "Batsmen" },
{ name: "Daryl Mitchell", role: "Batsman", country: "NZ", base: 1.5, set: "Batsmen" },
{ name: "Will Young", role: "Batsman", country: "NZ", base: 1.0, set: "Batsmen" },
{ name: "Mark Chapman", role: "Batsman", country: "NZ", base: 1.0, set: "Batsmen" },
{ name: "Fakhar Zaman", role: "Batsman", country: "PAK", base: 1.5, set: "Batsmen" },
{ name: "Abdullah Shafique", role: "Batsman", country: "PAK", base: 1.0, set: "Batsmen" },
{ name: "Imam-ul-Haq", role: "Batsman", country: "PAK", base: 1.0, set: "Batsmen" },
{ name: "Ibrahim Zadran", role: "Batsman", country: "AFG", base: 1.0, set: "Batsmen" },
{ name: "Charith Asalanka", role: "Batsman", country: "SL", base: 1.0, set: "Batsmen" },
{ name: "Avishka Fernando", role: "Batsman", country: "SL", base: 0.5, set: "Batsmen" },
{ name: "Towhid Hridoy", role: "Batsman", country: "BAN", base: 0.5, set: "Batsmen" },
{ name: "Litton Das", role: "Batsman", country: "BAN", base: 1.0, set: "Batsmen" },
{ name: "Najmul Hossain Shanto", role: "Batsman", country: "BAN", base: 1.0, set: "Batsmen" },
{ name: "Brandon King", role: "Batsman", country: "WI", base: 1.0, set: "Batsmen" },
{ name: "Keacy Carty", role: "Batsman", country: "WI", base: 0.5, set: "Batsmen" },
{ name: "Paul Stirling", role: "Batsman", country: "IRE", base: 1.0, set: "Batsmen" },
{ name: "Andy Balbirnie", role: "Batsman", country: "IRE", base: 0.5, set: "Batsmen" },
{ name: "Max O'Dowd", role: "Batsman", country: "NED", base: 0.5, set: "Batsmen" },
{ name: "Nitish Rana", role: "Batsman", country: "IND", base: 0.5, set: "Batsmen" },
{ name: "Finn Allen", role: "Batsman", country: "NZ", base: 1.0, set: "Batsmen" },
{ name: "Nuwanidu Fernando", role: "Batsman", country: "SL", base: 0.5, set: "Batsmen" },
{ name: "Rinku Singh", role: "Batsman", country: "IND", base: 1.0, set: "Batsmen" },
{ name: "Angkrish Raghuvanshi", role: "Batsman", country: "IND", base: 0.5, set: "Batsmen" },
{ name: "Dewald Brevis", role: "Batsman", country: "SA", base: 1.0, set: "Batsmen" },
{ name: "Babar Azam", role: "Batsman", country: "PAK", base: 2.0, set: "Batsmen" },
{ name: "Saim Ayub", role: "Batsman", country: "PAK", base: 1.0, set: "Batsmen" },
{ name: "Rahmat Shah", role: "Batsman", country: "AFG", base: 1.0, set: "Batsmen" },
{ name: "Kusal Perera", role: "Batsman", country: "SL", base: 1.0, set: "Batsmen" },
{ name: "Rilee Rossouw", role: "Batsman", country: "SA", base: 1.0, set: "Batsmen" },
{ name: "Tom Banton", role: "Batsman", country: "ENG", base: 0.5, set: "Batsmen" },
{ name: "Jonathan Campbell", role: "Batsman", country: "ZIM", base: 0.5, set: "Batsmen" },


{ name: "KL Rahul", role: "Wicketkeeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Rishabh Pant", role: "Wicketkeeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Sanju Samson", role: "Wicketkeeper", country: "IND", base: 1.5, set: "Wicketkeepers" },
{ name: "Ishan Kishan", role: "Wicketkeeper", country: "IND", base: 1.0, set: "Wicketkeepers" },
{ name: "Dhruv Jurel", role: "Wicketkeeper", country: "IND", base: 1.0, set: "Wicketkeepers" },

{ name: "Tom Latham", role: "Wicketkeeper", country: "NZ", base: 1.0, set: "Wicketkeepers" },
{ name: "Kusal Mendis", role: "Wicketkeeper", country: "SL", base: 1.0, set: "Wicketkeepers" },
{ name: "Rahmanullah Gurbaz", role: "Wicketkeeper", country: "AFG", base: 1.0, set: "Wicketkeepers" },
{ name: "Mohammad Haris", role: "Wicketkeeper", country: "PAK", base: 0.5, set: "Wicketkeepers" },
{ name: "Sadeera Samarawickrama", role: "Wicketkeeper", country: "SL", base: 0.5, set: "Wicketkeepers" },

{ name: "Josh Inglis", role: "Wicketkeeper", country: "AUS", base: 1.0, set: "Wicketkeepers" },
{ name: "Alex Carey", role: "Wicketkeeper", country: "AUS", base: 1.0, set: "Wicketkeepers" },
{ name: "Jamie Smith", role: "Wicketkeeper", country: "ENG", base: 1.0, set: "Wicketkeepers" },
{ name: "Ben Foakes", role: "Wicketkeeper", country: "ENG", base: 0.5, set: "Wicketkeepers" },
{ name: "Kyle Verreynne", role: "Wicketkeeper", country: "SA", base: 1.0, set: "Wicketkeepers" },

{ name: "Shai Hope", role: "Wicketkeeper", country: "WI", base: 1.5, set: "Wicketkeepers" },
{ name: "Scott Edwards", role: "Wicketkeeper", country: "NED", base: 0.5, set: "Wicketkeepers" },
{ name: "Jitesh Sharma", role: "Wicketkeeper", country: "IND", base: 0.5, set: "Wicketkeepers" },
{ name: "Devon Thomas", role: "Wicketkeeper", country: "WI", base: 0.5, set: "Wicketkeepers" },

{ name: "Phil Salt", role: "Wicketkeeper", country: "ENG", base: 1.5, set: "Wicketkeepers" },
{ name: "Mushfiqur Rahim", role: "Wicketkeeper", country: "BAN", base: 1.0, set: "Wicketkeepers" },
{ name: "Dinesh Chandimal", role: "Wicketkeeper", country: "SL", base: 1.0, set: "Wicketkeepers" },
{ name: "Johnson Charles", role: "Wicketkeeper", country: "WI", base: 0.5, set: "Wicketkeepers" },
{ name: "Matthew Short", role: "Wicketkeeper", country: "AUS", base: 1.0, set: "Wicketkeepers" },

{ name: "Mohammed Siraj", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Arshdeep Singh", role: "Bowler", country: "IND", base: 1.5, set: "Pacers" },
{ name: "Prasidh Krishna", role: "Bowler", country: "IND", base: 1.0, set: "Pacers" },
{ name: "Harshit Rana", role: "Bowler", country: "IND", base: 1.0, set: "Pacers" },
{ name: "Akash Deep", role: "Bowler", country: "IND", base: 1.0, set: "Pacers" },
{ name: "Mukesh Kumar", role: "Bowler", country: "IND", base: 0.5, set: "Pacers" },
{ name: "T Natarajan", role: "Bowler", country: "IND", base: 1.0, set: "Pacers" },
{ name: "Avesh Khan", role: "Bowler", country: "IND", base: 0.5, set: "Pacers" },

{ name: "Josh Hazlewood", role: "Bowler", country: "AUS", base: 1.5, set: "Pacers" },
{ name: "Nathan Ellis", role: "Bowler", country: "AUS", base: 1.0, set: "Pacers" },
{ name: "Spencer Johnson", role: "Bowler", country: "AUS", base: 1.0, set: "Pacers" },

{ name: "Matt Henry", role: "Bowler", country: "NZ", base: 1.5, set: "Pacers" },
{ name: "Lockie Ferguson", role: "Bowler", country: "NZ", base: 1.5, set: "Pacers" },
{ name: "Will O'Rourke", role: "Bowler", country: "NZ", base: 1.0, set: "Pacers" },
{ name: "Ben Sears", role: "Bowler", country: "NZ", base: 1.0, set: "Pacers" },

{ name: "Anrich Nortje", role: "Bowler", country: "SA", base: 1.5, set: "Pacers" },
{ name: "Lungi Ngidi", role: "Bowler", country: "SA", base: 1.0, set: "Pacers" },

{ name: "Shaheen Afridi", role: "Bowler", country: "PAK", base: 1.5, set: "Pacers" },
{ name: "Naseem Shah", role: "Bowler", country: "PAK", base: 1.5, set: "Pacers" },
{ name: "Haris Rauf", role: "Bowler", country: "PAK", base: 1.5, set: "Pacers" },

{ name: "Dilshan Madushanka", role: "Bowler", country: "SL", base: 1.0, set: "Pacers" },

{ name: "Taskin Ahmed", role: "Bowler", country: "BAN", base: 1.0, set: "Pacers" },
{ name: "Mustafizur Rahman", role: "Bowler", country: "BAN", base: 1.0, set: "Pacers" },
{ name: "Tanzim Hasan Sakib", role: "Bowler", country: "BAN", base: 0.5, set: "Pacers" },

{ name: "Alzarri Joseph", role: "Bowler", country: "WI", base: 1.0, set: "Pacers" },

{ name: "Mark Wood", role: "Bowler", country: "ENG", base: 1.5, set: "Pacers" },
{ name: "Gus Atkinson", role: "Bowler", country: "ENG", base: 1.0, set: "Pacers" },
{ name: "Reece Topley", role: "Bowler", country: "ENG", base: 1.0, set: "Pacers" },

{ name: "Naveen-ul-Haq", role: "Bowler", country: "AFG", base: 1.0, set: "Pacers" },
{ name: "Fazalhaq Farooqi", role: "Bowler", country: "AFG", base: 1.0, set: "Pacers" },

{ name: "Blessing Muzarabani", role: "Bowler", country: "ZIM", base: 1.0, set: "Pacers" },
{ name: "Richard Ngarava", role: "Bowler", country: "ZIM", base: 0.5, set: "Pacers" },

{ name: "Paul van Meekeren", role: "Bowler", country: "NED", base: 0.5, set: "Pacers" },



{ name: "Adam Zampa", role: "Bowler", country: "AUS", base: 1.5, set: "Spinners" },

{ name: "Keshav Maharaj", role: "Bowler", country: "SA", base: 1.0, set: "Spinners" },
{ name: "Tabraiz Shamsi", role: "Bowler", country: "SA", base: 1.0, set: "Spinners" },

{ name: "Abrar Ahmed", role: "Bowler", country: "PAK", base: 1.0, set: "Spinners" },

{ name: "Maheesh Theekshana", role: "Bowler", country: "SL", base: 1.0, set: "Spinners" },
{ name: "Wanindu Hasaranga", role: "Bowler", country: "SL", base: 1.5, set: "Spinners" },
{ name: "Jeffrey Vandersay", role: "Bowler", country: "SL", base: 0.5, set: "Spinners" },

{ name: "Gudakesh Motie", role: "Bowler", country: "WI", base: 0.5, set: "Spinners" },
{ name: "Akeal Hosein", role: "Bowler", country: "WI", base: 0.5, set: "Spinners" },

{ name: "Adil Rashid", role: "Bowler", country: "ENG", base: 1.0, set: "Spinners" },

{ name: "Mujeeb Ur Rahman", role: "Bowler", country: "AFG", base: 1.0, set: "Spinners" },




{ name: "Axar Patel", role: "All-Rounder", country: "IND", base: 1.5, set: "All-Rounders" },
{ name: "Washington Sundar", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounders" },
{ name: "Nitish Kumar Reddy", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounders" },
{ name: "Shivam Dube", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounders" },
{ name: "Riyan Parag", role: "All-Rounder", country: "IND", base: 1.0, set: "All-Rounders" },

{ name: "Sam Curran", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Liam Livingstone", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },
{ name: "Jacob Bethell", role: "All-Rounder", country: "ENG", base: 1.0, set: "All-Rounders" },
{ name: "Moeen Ali", role: "All-Rounder", country: "ENG", base: 1.5, set: "All-Rounders" },

{ name: "Michael Bracewell", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounders" },
{ name: "Rachin Ravindra", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounders" },
{ name: "Mitchell Santner", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounders" },
{ name: "Glenn Phillips", role: "All-Rounder", country: "NZ", base: 1.5, set: "All-Rounders" },
{ name: "Jimmy Neesham", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounders" },
{ name: "Kyle Jamieson", role: "All-Rounder", country: "NZ", base: 1.0, set: "All-Rounders" },

{ name: "Marcus Stoinis", role: "All-Rounder", country: "AUS", base: 1.5, set: "All-Rounders" },
{ name: "Cameron Green", role: "All-Rounder", country: "AUS", base: 1.5, set: "All-Rounders" },
{ name: "Aaron Hardie", role: "All-Rounder", country: "AUS", base: 1.0, set: "All-Rounders" },

{ name: "Sikandar Raza", role: "All-Rounder", country: "ZIM", base: 1.5, set: "All-Rounders" },
{ name: "Sean Williams", role: "All-Rounder", country: "ZIM", base: 1.0, set: "All-Rounders" },

{ name: "Mehidy Hasan Miraz", role: "All-Rounder", country: "BAN", base: 1.5, set: "All-Rounders" },
{ name: "Mahmudullah", role: "All-Rounder", country: "BAN", base: 1.0, set: "All-Rounders" },
{ name: "Shakib Al Hasan", role: "All-Rounder", country: "BAN", base: 2.0, set: "All-Rounders" },

{ name: "Azmatullah Omarzai", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounders" },
{ name: "Mohammad Nabi", role: "All-Rounder", country: "AFG", base: 1.5, set: "All-Rounders" },

{ name: "Sherfane Rutherford", role: "All-Rounder", country: "WI", base: 1.0, set: "All-Rounders" },
{ name: "Roston Chase", role: "All-Rounder", country: "WI", base: 1.0, set: "All-Rounders" },
{ name: "Jason Holder", role: "All-Rounder", country: "WI", base: 1.5, set: "All-Rounders" },
{ name: "Romario Shepherd", role: "All-Rounder", country: "WI", base: 1.0, set: "All-Rounders" },
{ name: "Odean Smith", role: "All-Rounder", country: "WI", base: 0.5, set: "All-Rounders" },

{ name: "Gerhard Erasmus", role: "All-Rounder", country: "NAM", base: 1.0, set: "All-Rounders" },
{ name: "Bas de Leede", role: "All-Rounder", country: "NED", base: 1.0, set: "All-Rounders" },

{ name: "Dhananjaya de Silva", role: "All-Rounder", country: "SL", base: 1.0, set: "All-Rounders" },
{ name: "Chamika Karunaratne", role: "All-Rounder", country: "SL", base: 0.5, set: "All-Rounders" }
            ],
            "TEST_LEGENDS": [
                { name: "Sachin Tendulkar", role: "Batsman", country: "IND", base: 2.0, set: "Marquee" },
                { name: "Shane Warne", role: "Spinner", country: "AUS", base: 2.0, set: "Spinners" },
                { name: "Muttiah Muralitharan", role: "Spinner", country: "SL", base: 2.0, set: "Spinners" }
            ],
            "ODI_LEGENDS": [
                { name: "Viv Richards", role: "Batsman", country: "WI", base: 2.0, set: "Marquee" },
                { name: "Wasim Akram", role: "Pacer", country: "PAK", base: 2.0, set: "Pacers" },
                { name: "Ricky Ponting", role: "Batsman", country: "AUS", base: 2.0, set: "Marquee" }
            ]
        };

        buttons.create?.addEventListener('click', async () => {
            const format = document.getElementById('format-input').value;
            if(!currentUser) return showToast("Authenticating... wait a moment.");
            await createRoom(generateRoomCode(), format);
        });

        buttons.join?.addEventListener('click', async () => {
            const code = inputs.roomCode.value.trim().toUpperCase();
            if(!code) return showToast("Enter a room code!");
            if(!currentUser) return showToast("Authenticating... wait a moment.");
            await joinRoom(code);
        });

        buttons.leave?.addEventListener('click', () => {
            hideFloatingButtons();
            modalElements.modal.classList.remove('hidden');
            setTimeout(() => { modalElements.modal.classList.remove('opacity-0'); modalElements.content.classList.remove('scale-95'); modalElements.content.classList.add('scale-100'); }, 10);
        });
        
        modalElements.cancel?.addEventListener('click', () => {
            modalElements.modal.classList.add('opacity-0');
            modalElements.content.classList.remove('scale-100'); modalElements.content.classList.add('scale-95');
            setTimeout(() => { 
                modalElements.modal.classList.add('hidden'); 
                showFloatingButtons();
            }, 300);
        });
        
        modalElements.confirm?.addEventListener('click', async () => {
            if (myUserDocId && auth.currentUser) {
                try {
                    await transferHostRole();
                    await updateDoc(doc(getUsersRef(), myUserDocId), { isOnline: false });
                } catch (e) { console.error("Exit err:", e); }
            }
            window.location.reload();
        });

        window.addEventListener('beforeunload', () => { if (myUserDocId && auth.currentUser) { transferHostRole(); updateDoc(doc(getUsersRef(), myUserDocId), { isOnline: false }).catch(() => {}); } });
        document.addEventListener('visibilitychange', () => { if (myUserDocId && auth.currentUser) { updateDoc(doc(getUsersRef(), myUserDocId), { lastActive: Date.now() }).catch(() => {}); } });
        window.addEventListener('offline', () => { if (myUserDocId && auth.currentUser) updateDoc(doc(getUsersRef(), myUserDocId), { isOnline: false }).catch(() => {}); });
        window.addEventListener('online', () => { if (myUserDocId && auth.currentUser) updateDoc(doc(getUsersRef(), myUserDocId), { isOnline: true, lastActive: Date.now() }).catch(() => {}); });

        async function transferHostRole() {
            if (!usersData || !myUserDocId || !currentRoomId) return;
            const me = usersData.find(u => u.userId === myUserDocId);
            if (me && me.role === 'admin') {
                const others = usersData.filter(u => u.userId !== myUserDocId && u._computedOnline);
                if (others.length > 0) {
                    others.sort((a, b) => {
                        const timeA = a.joinedAt || 0; const timeB = b.joinedAt || 0;
                        if (timeA === timeB) return a.userId.localeCompare(b.userId); return timeA - timeB;
                    });
                    const nextHost = others[0];
                    try {
                        await runTransaction(db, async (transaction) => {
                            const roomRef = doc(getRoomsRef(), currentRoomId);
                            const roomDoc = await transaction.get(roomRef);
                            // Only safely transfer if I am still the host according to DB
                            if (!roomDoc.exists() || roomDoc.data().hostId !== currentUser.uid) return;

                            const myUserRef = doc(getUsersRef(), myUserDocId);
                            const nextHostRef = doc(getUsersRef(), nextHost.userId);

                            transaction.update(myUserRef, { role: 'player' });
                            transaction.update(nextHostRef, { role: 'admin' });
                            transaction.update(roomRef, { hostId: nextHost.authId });
                        });
                    } catch (e) { console.error("Atomic transfer failed:", e); }
                }
            }
        }
        
        window.transferHostTo = async (targetUserId) => {
            if (!myUserDocId || !usersData || !auth.currentUser || !currentRoomId) return;
            const me = usersData.find(u => u.userId === myUserDocId);
            if (me && me.role === 'admin') {
                const targetUser = usersData.find(u => u.userId === targetUserId);
                if (targetUser) {
                    try {
                        await runTransaction(db, async (transaction) => {
                            const roomRef = doc(getRoomsRef(), currentRoomId);
                            const roomDoc = await transaction.get(roomRef);
                            // Only safely transfer if I am still the host according to DB
                            if (!roomDoc.exists() || roomDoc.data().hostId !== currentUser.uid) return Promise.reject("Not current host");

                            const myUserRef = doc(getUsersRef(), myUserDocId);
                            const nextHostRef = doc(getUsersRef(), targetUser.userId);

                            transaction.update(myUserRef, { role: 'player' });
                            transaction.update(nextHostRef, { role: 'admin' });
                            transaction.update(roomRef, { hostId: targetUser.authId });
                        });
                        showToast(`Transferred host to ${targetUser.username}`);
                    } catch (e) { console.error(e); showToast("Failed to transfer host."); }
                }
            }
        };

        window.openKickModal = (userId, name) => {
            showToast(`Kick ${name}?`, `<button onclick="kickPlayer('${userId}')" class="mt-2 w-full bg-orange-500 hover:bg-orange-600 text-white px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest shadow-md transition-colors">Confirm Kick</button>`);
        };

        window.kickPlayer = async (userId) => {
            document.getElementById('toast').classList.remove('show');
            try {
                await updateDoc(doc(getUsersRef(), userId), { kicked: true, isOnline: false });
                showToast("Player kicked successfully.");
            } catch(e) { console.error(e); showToast("Failed to kick player."); }
        };

        window.openBanModal = (userId, name) => {
            showToast(`Permanently Ban ${name}?`, `<button onclick="banPlayer('${userId}')" class="mt-2 w-full bg-red-500 hover:bg-red-600 text-white px-3 py-2 rounded-lg text-xs font-black uppercase tracking-widest shadow-md transition-colors">Confirm Ban</button>`);
        };

        window.banPlayer = async (userId) => {
            document.getElementById('toast').classList.remove('show');
            try {
                await updateDoc(doc(getUsersRef(), userId), { banned: true, isOnline: false });
                showToast("Player banned successfully.");
            } catch(e) { console.error(e); showToast("Failed to ban player."); }
        };

        async function createRoom(roomId, format) {
            const username = currentUser.displayName || getGuestName();
            try {
                buttons.create.disabled = true; buttons.create.innerText = "Hosting...";
                await setDoc(doc(getRoomsRef(), roomId), {
                    roomId: roomId, hostId: currentUser.uid, status: 'waiting', format: format,
                    currentAuctionIndex: 0, timerEndTime: 0, currentBid: 0, currentBidder: null, createdAt: serverTimestamp()
                });

                myUserDocId = currentUser.uid + "_" + roomId; 
                
                await setDoc(doc(getUsersRef(), myUserDocId), {
                    userId: myUserDocId, authId: currentUser.uid, roomId: roomId, username: username,
                    budget: BUDGET_DEFAULT, role: 'admin', joinedAt: Date.now(), isOnline: true,
                    kicked: false, banned: false, peerId: null, lastActive: Date.now(), serverTime: serverTimestamp()
                });

                const batch = writeBatch(db);
                const playersToLoad = AUCTION_DATABASES[format] || AUCTION_DATABASES["T20"];
                
                playersToLoad.forEach((p, idx) => {
                    const pRef = doc(getPlayersRef());
                    batch.set(pRef, { playerId: pRef.id, roomId: roomId, name: p.name, role: p.role, country: p.country, basePrice: p.base, set: p.set, soldPrice: null, ownerId: null, status: 'upcoming', order: idx });
                });
                await batch.commit();
                enterRoom(roomId);
            } catch(e) { 
                console.warn("Create Room Error:", e); 
                if (String(e).includes("permissions") || String(e.message).includes("permissions")) {
                    showToast("Database Permission Denied!", `<div class="mt-2 text-[10px] text-red-200 font-medium leading-relaxed tracking-wide">Please go to Firebase Console -> Firestore Database -> Rules and ensure they are exactly:<br><br><code class="bg-black/50 p-1.5 rounded block mt-1 text-emerald-400">allow read, write: if true;</code></div>`);
                } else {
                    showToast("Error: " + (e.message || "Failed to create room")); 
                }
                buttons.create.disabled = false; 
                buttons.create.innerText = "Host New Auction"; 
            }
        }

        async function joinRoom(roomId) {
            const username = currentUser.displayName || getGuestName();
            try {
                buttons.join.disabled = true;
                const roomsSnap = await getDocs(getRoomsRef());
                let foundRoomId = null;
                roomsSnap.forEach(docSnap => {
                    const data = docSnap.data();
                    if (data.roomId && data.roomId.toUpperCase() === roomId.toUpperCase()) foundRoomId = data.roomId;
                });
                if (!foundRoomId) { showToast("Invalid Room Code."); buttons.join.disabled = false; return; }
                roomId = foundRoomId;

                const usersSnap = await getDocs(getUsersRef());
                let isBanned = false;
                let activeUsersInRoom = 0;
                let isAlreadyInRoom = false;
                usersSnap.forEach(docSnap => {
                    const data = docSnap.data();
                    if (data.roomId === roomId) {
                        if (data.authId === currentUser.uid) {
                            isAlreadyInRoom = true;
                            if (data.banned) isBanned = true;
                        } else if (!data.kicked && !data.banned) {
                            activeUsersInRoom++;
                        }
                    }
                });
                if (isBanned) { showToast("You are permanently banned."); buttons.join.disabled = false; return; }

                if (!isAlreadyInRoom && activeUsersInRoom >= 10) {
                    showToast("Room is full! Maximum 10 franchises allowed.");
                    buttons.join.disabled = false;
                    return;
                }

                myUserDocId = currentUser.uid + "_" + roomId;
                
                const userRef = doc(getUsersRef(), myUserDocId);
                const userSnap = await getDoc(userRef);
                if (userSnap.exists()) {
                    await updateDoc(userRef, { username: username, isOnline: true, kicked: false, lastActive: Date.now(), serverTime: serverTimestamp() });
                } else {
                    await setDoc(userRef, {
                        userId: myUserDocId, authId: currentUser.uid, roomId: roomId, username: username,
                        budget: BUDGET_DEFAULT, role: 'player', joinedAt: Date.now(), isOnline: true,
                        kicked: false, banned: false, peerId: null, lastActive: Date.now(), serverTime: serverTimestamp()
                    });
                }
                enterRoom(roomId);
            } catch(e) { 
                console.warn("Join Room Error:", e); 
                if (String(e).includes("permissions") || String(e.message).includes("permissions")) {
                    showToast("Database Permission Denied!", `<div class="mt-2 text-[10px] text-red-200 font-medium leading-relaxed tracking-wide">Please go to Firebase Console -> Firestore Database -> Rules and ensure they are exactly:<br><br><code class="bg-black/50 p-1.5 rounded block mt-1 text-emerald-400">allow read, write: if true;</code></div>`);
                } else {
                    showToast("Error: " + (e.message || "Failed to join room")); 
                }
                buttons.join.disabled = false; 
            }
        }

        function enterRoom(roomId) {
            currentRoomId = roomId;
            screens.lobby.classList.add('hidden');
            screens.lobby.classList.remove('flex');
            screens.auction.classList.remove('hidden');
            screens.auction.classList.add('flex');
            ui.roomCode.innerText = roomId;
            
            document.getElementById('reaction-buttons')?.classList.remove('hidden');
            document.getElementById('reaction-buttons')?.classList.add('flex');

            showFloatingButtons();

            setupListeners(); initVoiceChat(); startHeartbeat();
        }

        function startHeartbeat() {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            heartbeatInterval = setInterval(() => { if (myUserDocId && auth.currentUser) { updateDoc(doc(getUsersRef(), myUserDocId), { lastActive: Date.now(), serverTime: serverTimestamp() }).catch(()=>{}); } }, 15000); 
        }

        function setupListeners() {
            if(!currentUser) return;
            unsubscribeRooms = onSnapshot(getRoomsRef(), (snapshot) => {
                snapshot.forEach(docSnap => { 
                    const data = docSnap.data(); 
                    if(data.roomId === currentRoomId) { roomData = data; updateRoomUI(); } 
                });
            }, (error) => { console.error("Room sync error", error) });

            unsubscribeUsers = onSnapshot(getUsersRef(), (snapshot) => {
                const tempUsers = []; const now = Date.now();
                snapshot.forEach(docSnap => {
                    const data = docSnap.data();
                    if(data.roomId === currentRoomId) {
                        const isHeartbeatAlive = data.lastActive ? (now - data.lastActive < 75000) : true;
                        data._computedOnline = data.isOnline !== false && isHeartbeatAlive;
                        tempUsers.push(data);
                        
                        if (data.userId === myUserDocId && data.serverTime && !docSnap.metadata.hasPendingWrites) {
                            serverTimeOffset = data.serverTime.toMillis() - Date.now();
                        }
                    }
                });
                usersData = tempUsers;
                
                const me = usersData.find(u => u.userId === myUserDocId);
                if (me && me.kicked) { showToast("You were kicked."); setTimeout(() => window.location.reload(), 2000); return; }
                if (me && me.banned) { showToast("You are banned."); setTimeout(() => window.location.reload(), 2000); return; }

                const onlineUsers = usersData.filter(u => u._computedOnline);
                if (onlineUsers.length > 0) {
                    const hasAdmin = onlineUsers.some(u => u.role === 'admin');
                    if (!hasAdmin && !failoverTimer) {
                        failoverTimer = setTimeout(async () => {
                            const currentOnline = usersData.filter(u => u._computedOnline);
                            if (!currentOnline.some(u => u.role === 'admin') && currentOnline.length > 0) {
                                const sortedUsers = [...currentOnline].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
                                if (sortedUsers[0].userId === myUserDocId) {
                                    try {
                                        // Using runTransaction for safe, atomic client-side failover fallback
                                        await runTransaction(db, async (transaction) => {
                                            const roomRef = doc(getRoomsRef(), currentRoomId);
                                            const roomDoc = await transaction.get(roomRef);
                                            if (!roomDoc.exists()) return;
                                            
                                            const myUserRef = doc(getUsersRef(), myUserDocId);
                                            transaction.update(myUserRef, { role: 'admin' });
                                            transaction.update(roomRef, { hostId: currentUser.uid });
                                        });
                                    } catch(e) { console.error("Failover atomic transaction failed", e); }
                                }
                            }
                            failoverTimer = null;
                        }, 12000); 
                    } else if (hasAdmin && failoverTimer) { clearTimeout(failoverTimer); failoverTimer = null; }
                }

                if (peer && !peer.destroyed && myPeerId) {
                    usersData.forEach(u => {
                        if (u.userId !== myUserDocId && u._computedOnline && u.peerId && !connectedPeers.has(u.peerId)) {
                            const me = usersData.find(m => m.userId === myUserDocId);
                            if (me && (me.joinedAt > u.joinedAt || (me.joinedAt === u.joinedAt && myUserDocId > u.userId))) { makeCall(u.peerId); }
                        }
                        if (!u._computedOnline && u.peerId && connectedPeers.has(u.peerId)) {
                            connectedPeers.delete(u.peerId); activeStreams.delete(u.peerId);
                        }
                    });
                }
                updateUsersUI(); updateVideoGallery();
                if (roomData && roomData.status === 'finished') updateRoomUI();
            }, (error) => { console.error("Users sync error", error) });

            unsubscribePlayers = onSnapshot(getPlayersRef(), (snapshot) => {
                const tempPlayers = [];
                snapshot.forEach(docSnap => { const data = docSnap.data(); if(data.roomId === currentRoomId) tempPlayers.push(data); });
                playersData = tempPlayers.sort((a, b) => a.order - b.order);
                updatePlayersUI();
                processPrefetchQueue();
                if (roomData && roomData.status === 'finished') updateRoomUI();
            }, (error) => { console.error("Players sync error", error) });

            unsubscribeChat = onSnapshot(getChatRef(currentRoomId), (snapshot) => {
                const msgs = [];
                snapshot.docChanges().forEach(change => {
                    const data = change.doc.data();
                    if (data.roomId === currentRoomId) {
                        if (change.type === 'added' && data.type === 'reaction') {
                            if (Date.now() - data.timestamp < 5000 && data.senderId !== myUserDocId) {
                                animateReaction(data.emoji);
                            }
                        }
                    }
                });

                snapshot.forEach(docSnap => {
                    const data = docSnap.data();
                    if(data.roomId === currentRoomId && !data.type) {
                        if(data.receiverId === 'all' || data.senderId === myUserDocId || data.receiverId === myUserDocId) { msgs.push(data); }
                    }
                });
                chatMessages = msgs.sort((a,b) => a.timestamp - b.timestamp).slice(-50);
                updateChatUI();
            }, (error) => { console.error("Chat sync error", error) });
        }

        window.sendReaction = (emoji) => {
            if (!currentRoomId || !myUserDocId || !auth.currentUser) return;
            const msgRef = doc(getChatRef(currentRoomId));
            setDoc(msgRef, {
                id: msgRef.id, roomId: currentRoomId, senderId: myUserDocId, 
                type: 'reaction', emoji: emoji, timestamp: Date.now()
            }).catch(console.error);
            animateReaction(emoji);
        };

        function animateReaction(emoji) {
            const container = document.getElementById('reaction-container');
            if (!container) return;
            const el = document.createElement('div');
            el.className = 'absolute bottom-0 text-3xl sm:text-4xl animate-float-up opacity-100 pointer-events-none drop-shadow-lg';
            el.innerText = emoji;
            el.style.left = (Math.random() * 40) + 'px';
            container.appendChild(el);
            setTimeout(() => el.remove(), 2000);
        }

        function processPrefetchQueue() {
            if (!playersData || playersData.length === 0) return;
            const upcoming = playersData.filter(p => p.status === 'upcoming').sort((a,b) => a.order - b.order);
            for(let i = 0; i < Math.min(8, upcoming.length); i++) {
                const p = upcoming[i];
                if (!playerStatsCache[p.name] && !activeFetches[p.name]) {
                    fetchRealPlayerStats(p).catch(()=>{});
                }
            }
        }

        function getHash(str) { let h=0; for(let i=0;i<str.length;i++) h=(h<<5)-h+str.charCodeAt(i); return Math.abs(h); }

        function getFallbackAnalytics(player) {
            const h = getHash(player.name);
            let baseMatches = 30;
            if(player.set === "Marquee") baseMatches = 90;
            else if(player.set === "Batsmen" || player.set === "Pacers") baseMatches = 50;
            
            const matches = baseMatches + (h % 40);
            const base = player.basePrice || player.base || 0;

            let calculatedRating = 6.0;
            if(base >= 2.0) calculatedRating = 8.5;
            else if(base >= 1.5) calculatedRating = 7.5;
            else if(base >= 1.0) calculatedRating = 6.5;

            const aiRating = (calculatedRating + ((h % 15) / 10)).toFixed(1);
            const predMin = (base * (1 + (h % 5) * 0.3)).toFixed(2);
            const predMax = (parseFloat(predMin) + 1.0 + ((h % 5) * 0.5)).toFixed(2);
            
            let form = [];
            let stat1 = { label: 'Runs', val: 0 };
            let stat2 = { label: 'Strike Rate', val: 0 };

            if(player.role.includes('Batsman') || player.role.includes('Wicketkeeper')) {
                stat1.val = matches * (20 + (h % 25));
                stat2.val = (120 + (h % 45)).toFixed(1);
                for(let i=0;i<5;i++) form.push( (h%(i*10+20)) + (i*15) + (i===2?'*':'') );
            } else if(player.role.includes('Pacer') || player.role.includes('Spinner')) {
                stat1 = { label: 'Wickets', val: matches + (h % 40) };
                stat2 = { label: 'Economy', val: (6.0 + ((h % 30)/10)).toFixed(2) };
                for(let i=0;i<5;i++) form.push( (h%(i*2+4)) + 'W' );
            } else { // All-rounder
                stat1 = { label: 'Runs', val: matches * (15 + (h % 20)) };
                stat2 = { label: 'Wickets', val: Math.floor(matches * 0.8) + (h % 20) };
                for(let i=0;i<5;i++) form.push( i%2===0 ? ((h%(i*10+20))*2) : ((h%(i*2+3))+'W') );
            }
            
            return { matches, stat1, stat2, form, aiRating, predMin: parseFloat(predMin), predMax: parseFloat(predMax) };
        }

        function getTeamRating(teamId) {
            const teamPlayers = playersData.filter(p => p.ownerId === teamId);
            if (teamPlayers.length === 0) return "0.0";
            
            let totalRating = 0;
            teamPlayers.forEach(p => {
                const stats = playerStatsCache[p.name] || getFallbackAnalytics(p);
                totalRating += parseFloat(stats.aiRating || 0);
            });
            
            return (totalRating / teamPlayers.length).toFixed(1);
        }

        async function fetchRealPlayerStats(player) {
            if (playerStatsCache[player.name]) return playerStatsCache[player.name];
            if (activeFetches[player.name]) return activeFetches[player.name];

            const fetchPromise = (async () => {
                const formatStr = roomData && roomData.format.startsWith('TEST') ? 'Test' : (roomData && roomData.format.startsWith('ODI') ? 'ODI' : 'T20I');
                const prompt = `Act as an expert Cricket Analyst. Retrieve the real-world international career stats strictly for the ${formatStr} format only (DO NOT include domestic, franchise, or other formats) and recent ${formatStr} form for the cricketer "${player.name}". 
Role: ${player.role}. Base Price: ${player.basePrice || player.base} Cr.
Return a JSON object exactly matching the schema. 
- matches: Total ${formatStr} matches played.
- stat1Label: 'Runs' if batsman/all-rounder, 'Wickets' if bowler.
- stat1Value: Total ${formatStr} runs or wickets.
- stat2Label: 'Strike Rate' if batsman, 'Economy' if bowler.
- stat2Value: Number value for SR or Economy.
- form: Array of exactly 5 recent ${formatStr} scores or bowling figures as strings.
- aiRating: A score out of 10.0 reflecting their real-world current franchise value.
- predictedValueMin: Minimum predicted auction price in Crores.
- predictedValueMax: Maximum predicted auction price in Crores.`;

                const payload = {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                "matches": { "type": "NUMBER" },
                                "stat1Label": { "type": "STRING" },
                                "stat1Value": { "type": "NUMBER" },
                                "stat2Label": { "type": "STRING" },
                                "stat2Value": { "type": "NUMBER" },
                                "form": { "type": "ARRAY", "items": { "type": "STRING" } },
                                "aiRating": { "type": "NUMBER" },
                                "predictedValueMin": { "type": "NUMBER" },
                                "predictedValueMax": { "type": "NUMBER" }
                            },
                            required: ["matches", "stat1Label", "stat1Value", "stat2Label", "stat2Value", "form", "aiRating", "predictedValueMin", "predictedValueMax"]
                        }
                    }
                };

                const apiKey = typeof __gemini_api_key !== 'undefined' ? __gemini_api_key : "";
                
                if (!apiKey) {
                    // FAST MOCK FALLBACK
                    const fallback = getFallbackAnalytics(player);
                    playerStatsCache[player.name] = fallback;
                    if (roomData && playersData.find(p => p.order === roomData.currentAuctionIndex)?.name === player.name) { renderPlayerAnalyticsUI(player, fallback); }
                    return fallback;
                }

                const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

                let result = null;
                let retries = 5;
                let delay = 1000;

                for (let i = 0; i < retries; i++) {
                    try {
                        if (!apiKey) throw new Error("No API Key available in environment context.");
                        const response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                        if (!response.ok) throw new Error('API Error');
                        result = await response.json();
                        break;
                    } catch (err) {
                        if (i === retries - 1) { console.warn("AI Fetch Error/Skipped - using fallback:", err); } 
                        else { await new Promise(res => setTimeout(res, delay)); delay *= 2; }
                    }
                }
                
                if (result && result.candidates && result.candidates.length > 0 && result.candidates[0].content?.parts?.[0]?.text) {
                    try {
                        const parsed = JSON.parse(result.candidates[0].content.parts[0].text);
                        const analytics = {
                            matches: parsed.matches,
                            stat1: { label: parsed.stat1Label, val: parsed.stat1Value },
                            stat2: { label: parsed.stat2Label, val: parsed.stat2Value },
                            form: parsed.form,
                            aiRating: parsed.aiRating.toFixed(1),
                            predMin: parsed.predictedValueMin,
                            predMax: parsed.predictedValueMax
                        };
                        playerStatsCache[player.name] = analytics;
                        if (roomData && playersData.find(p => p.order === roomData.currentAuctionIndex)?.name === player.name) {
                            renderPlayerAnalyticsUI(player, analytics);
                        }
                        return analytics;
                    } catch (parseErr) { console.error("JSON parsing error", parseErr); }
                }
                
                const fallback = getFallbackAnalytics(player);
                playerStatsCache[player.name] = fallback;
                if (roomData && playersData.find(p => p.order === roomData.currentAuctionIndex)?.name === player.name) { renderPlayerAnalyticsUI(player, fallback); }
                return fallback;
            })();

            activeFetches[player.name] = fetchPromise;
            const result = await fetchPromise;
            delete activeFetches[player.name];
            return result;
        }

        function renderPlayerAnalyticsUI(currentPlayer, analytics) {
            const statRating = document.getElementById('ui-stat-rating');
            if (!statRating) return;

            statRating.innerText = analytics.aiRating;
            document.getElementById('ui-stat-predicted').innerText = `â‚¹ ${analytics.predMin.toFixed(2)} - ${analytics.predMax.toFixed(2)} Cr`;
            document.getElementById('ui-stat-matches').innerText = analytics.matches;
            document.getElementById('ui-stat-l1').innerText = analytics.stat1.label;
            document.getElementById('ui-stat-v1').innerText = analytics.stat1.val;
            document.getElementById('ui-stat-l2').innerText = analytics.stat2.label;
            document.getElementById('ui-stat-v2').innerText = analytics.stat2.val;
            
            let formHtml = '';
            analytics.form.forEach(f => {
                let fStr = String(f);
                let color = fStr.includes('W') || fStr.includes('/') ? (parseInt(fStr)>1?'text-cric-green':'text-zinc-400') : (parseInt(fStr)>40?'text-cric-green':(parseInt(fStr)===0?'text-red-500':'text-zinc-400'));
                formHtml += `<div class="bg-zinc-950 border border-zinc-800 flex-1 py-1.5 sm:py-2 rounded-lg text-center font-bold font-display text-[10px] sm:text-xs ${color} shadow-inner truncate px-1">${fStr}</div>`;
            });
            document.getElementById('ui-stat-form').innerHTML = formHtml;

            const currentBidVal = roomData.currentBid > 0 ? roomData.currentBid : (currentPlayer.basePrice || currentPlayer.base || 0);
            const barCurrent = document.getElementById('ui-stat-bar-current');
            const barPredicted = document.getElementById('ui-stat-bar-predicted');
            const verdict = document.getElementById('ui-stat-verdict');
            
            const maxScale = analytics.predMax + 2.0;
            const predCenter = (analytics.predMin + analytics.predMax) / 2;
            
            barPredicted.style.width = `${Math.min(100, (predCenter / maxScale) * 100)}%`;
            barCurrent.style.width = `${Math.min(100, (currentBidVal / maxScale) * 100)}%`;
            
            if (currentBidVal < analytics.predMin) {
                verdict.innerText = "Steal Deal!"; verdict.className = "text-[9px] sm:text-[11px] font-bold text-emerald-400 uppercase tracking-wider";
                barCurrent.className = "absolute top-0 left-0 h-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)] transition-all duration-500 z-10";
            } else if (currentBidVal > analytics.predMax) {
                verdict.innerText = "Overpriced!"; verdict.className = "text-[9px] sm:text-[11px] font-bold text-red-500 uppercase tracking-wider";
                barCurrent.className = "absolute top-0 left-0 h-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)] transition-all duration-500 z-10";
            } else {
                verdict.innerText = "Fair Value"; verdict.className = "text-[9px] sm:text-[11px] font-bold text-yellow-400 uppercase tracking-wider";
                barCurrent.className = "absolute top-0 left-0 h-full bg-yellow-400 shadow-[0_0_10px_rgba(250,204,21,0.8)] transition-all duration-500 z-10";
            }
        }

        function updateVideoGallery() {
            const gallery = document.getElementById('video-gallery');
            if (!gallery) return;

            const currentIds = new Set();

            usersData.forEach(u => {
                if (u.userId !== myUserDocId && u._computedOnline) {
                    currentIds.add(u.userId);
                    
                    const stream = u.peerId ? activeStreams.get(u.peerId) : null;
                    let wrapper = document.getElementById(`peer-container-${u.userId}`);

                    if (!wrapper) {
                        wrapper = document.createElement('div');
                        wrapper.id = `peer-container-${u.userId}`;
                        wrapper.className = "relative group flex flex-col items-center animate-fade-in shrink-0 snap-start";
                        gallery.appendChild(wrapper);
                    }

                    if (stream && !wrapper.querySelector('video')) {
                        wrapper.innerHTML = '';
                        const videoWrap = document.createElement('div');
                        videoWrap.className = "p-0.5 rounded-[0.875rem] sm:rounded-[1.25rem] bg-gradient-to-b from-cric-green to-transparent";
                        const video = document.createElement('video');
                        video.srcObject = stream; video.autoplay = true; video.playsInline = true;
                        video.setAttribute('playsinline', '');
                        video.setAttribute('autoplay', '');
                        video.className = "w-10 h-10 sm:w-14 sm:h-14 md:w-16 md:h-16 rounded-[0.75rem] sm:rounded-[1rem] object-cover bg-zinc-800 block";
                        videoWrap.appendChild(video); wrapper.appendChild(videoWrap);
                        
                        const nameTag = document.createElement('span');
                        nameTag.className = "absolute -bottom-2 bg-zinc-900 border border-zinc-700 text-white text-[7px] sm:text-[9px] font-bold px-1.5 sm:px-2 py-0.5 rounded-md whitespace-nowrap z-10 shadow-sm uppercase tracking-wider";
                        nameTag.innerText = u.username;
                        wrapper.appendChild(nameTag);
                    } else if (!stream && !wrapper.querySelector('.avatar-box')) {
                        wrapper.innerHTML = '';
                        const avatar = document.createElement('div');
                        avatar.className = "avatar-box w-11 h-11 sm:w-[60px] sm:h-[60px] md:w-[68px] md:h-[68px] rounded-[0.875rem] sm:rounded-[1.25rem] border border-zinc-700 bg-zinc-800 flex items-center justify-center text-lg sm:text-xl md:text-2xl font-bold shadow-md text-zinc-300 font-display uppercase";
                        avatar.innerText = u.username.charAt(0); wrapper.appendChild(avatar);
                        
                        const nameTag = document.createElement('span');
                        nameTag.className = "absolute -bottom-2 bg-zinc-900 border border-zinc-700 text-white text-[7px] sm:text-[9px] font-bold px-1.5 sm:px-2 py-0.5 rounded-md whitespace-nowrap z-10 shadow-sm uppercase tracking-wider";
                        nameTag.innerText = u.username;
                        wrapper.appendChild(nameTag);
                    } else {
                        // Update name tag in place without destroying video element
                        const nameTag = wrapper.querySelector('span');
                        if (nameTag && nameTag.innerText !== u.username) nameTag.innerText = u.username;
                    }
                }
            });

            Array.from(gallery.children).forEach(child => {
                if (!child.querySelector('#local-video') && child.id && child.id.startsWith('peer-container-')) {
                    const uid = child.id.replace('peer-container-', '');
                    if (!currentIds.has(uid)) child.remove();
                }
            });
        }

        function updateUsersUI() {
            ui.onlineCount.innerText = usersData.filter(u => u._computedOnline).length;
            const amIHost = usersData.find(u => u.userId === myUserDocId)?.role === 'admin';
            
            if(amIHost) { ui.hostControls.classList.remove('hidden'); ui.hostControls.classList.add('flex'); } 
            else { ui.hostControls.classList.add('hidden'); ui.hostControls.classList.remove('flex'); }

            const me = usersData.find(u => u.userId === myUserDocId);
            if(me) ui.myBudget.innerText = `â‚¹ ${formatMoney(me.budget)} Cr`;

            ui.standingsList.innerHTML = '';
            const sortedUsers = [...usersData].sort((a,b) => b.budget - a.budget);
            
            sortedUsers.forEach(u => {
                const isMe = u.userId === myUserDocId;
                const isOffline = !u._computedOnline;
                const boughtPlayers = playersData.filter(p => p.ownerId === u.userId);
                const teamRating = getTeamRating(u.userId);

                let badgesHtml = '';
                if (boughtPlayers.length > 0) {
                    badgesHtml = '<div class="mt-2.5 sm:mt-3 flex flex-wrap gap-1.5">';
                    boughtPlayers.forEach(bp => { badgesHtml += `<span class="bg-zinc-950 border border-zinc-800 text-[9px] sm:text-[10px] px-2 py-1 rounded text-zinc-300 shadow-sm whitespace-nowrap">${bp.name} <span class="text-cric-gold font-bold">â‚¹${formatMoney(bp.soldPrice)}</span></span>`; });
                    badgesHtml += '</div>';
                }

                let adminControlsHtml = '';
                if (amIHost && !isMe) {
                    const safeName = u.username.replace(/'/g, "\\'");
                    let hostBtnHtml = '';
                    if (!isOffline) { hostBtnHtml = `<button onclick="transferHostTo('${u.userId}')" class="flex-1 text-[9px] sm:text-[10px] font-bold bg-zinc-800 text-zinc-300 hover:bg-zinc-700 py-1.5 sm:py-2 rounded-lg transition-colors border border-zinc-700">Make Host</button>`; }
                    adminControlsHtml = `
                        <div class="flex gap-1.5 sm:gap-2 mt-3 sm:mt-4 pt-2.5 sm:pt-3 border-t border-zinc-800/50">
                            ${hostBtnHtml}
                            <button onclick="openKickModal('${u.userId}', '${safeName}')" class="flex-1 text-[9px] sm:text-[10px] font-bold bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 py-1.5 sm:py-2 rounded-lg transition-colors border border-orange-500/20">Kick</button>
                            <button onclick="openBanModal('${u.userId}', '${safeName}')" class="flex-1 text-[9px] sm:text-[10px] font-bold bg-red-500/10 text-red-400 hover:bg-red-500/20 py-1.5 sm:py-2 rounded-lg transition-colors border border-red-500/20">Ban</button>
                        </div>
                    `;
                }

                const div = document.createElement('div');
                div.className = `p-3 sm:p-4 rounded-xl sm:rounded-[1.25rem] border ${isMe ? 'border-cric-green/50 bg-cric-green/5 shadow-[0_0_20px_rgba(16,185,129,0.05)]' : 'border-zinc-800/80 bg-zinc-900/50 hover:bg-zinc-900'} transition-colors flex flex-col justify-center ${isOffline ? 'opacity-40 grayscale' : ''}`;
                div.innerHTML = `
                    <div class="flex justify-between items-start w-full">
                        <div>
                            <p class="font-bold text-white text-sm sm:text-base flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-1.5 leading-tight tracking-wide">
                                ${u.username} 
                                <span class="flex gap-1 items-center">
                                    <span class="bg-purple-600/20 text-purple-400 border border-purple-500/30 text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm uppercase tracking-widest flex items-center gap-0.5">â­ ${teamRating}</span>
                                    ${u.role === 'admin' ? '<span class="text-[8px] sm:text-[9px] bg-red-500 text-white px-1.5 py-0.5 rounded shadow-sm uppercase tracking-widest font-black">Host</span>' : ''}
                                    ${isOffline ? '<span class="text-[8px] sm:text-[9px] bg-zinc-700 text-white px-1.5 py-0.5 rounded shadow-sm uppercase tracking-widest font-bold">Offline</span>' : ''}
                                </span>
                            </p>
                            <p class="text-[9px] sm:text-[10px] ${boughtPlayers.length < 13 ? 'text-red-400' : (boughtPlayers.length >= 18 ? 'text-cric-green' : 'text-zinc-500')} mt-1 uppercase tracking-widest font-bold">
                                Squad: ${boughtPlayers.length}/18 ${boughtPlayers.length < 13 ? '(Needs ' + (13 - boughtPlayers.length) + ' more)' : (boughtPlayers.length === 18 ? '(Full)' : '')}
                            </p>
                        </div>
                        <div class="text-right bg-zinc-950/80 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg sm:rounded-xl border border-zinc-800 shadow-inner">
                            <p class="font-display font-black text-cric-gold text-base sm:text-lg leading-none tracking-tight">â‚¹${formatMoney(u.budget)}</p>
                        </div>
                    </div>
                    ${badgesHtml}
                    ${adminControlsHtml}
                `;
                ui.standingsList.appendChild(div);
            });
            updateChatRecipients();
        }

        function updatePlayersUI() {
            let upcomingHtml = '';
            const upcoming = playersData.filter(p => p.status === 'upcoming');
            const sold = playersData.filter(p => p.status === 'sold');
            const unsold = playersData.filter(p => p.status === 'unsold');
            
            upcomingHtml += `<div class="text-[9px] sm:text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-1 sm:mt-2 mb-2 sm:mb-3 px-1">Upcoming (${upcoming.length})</div>`;
            upcoming.slice(0, 4).forEach(p => {
                upcomingHtml += `
                    <div class="p-2.5 sm:p-3.5 border border-zinc-800/80 bg-zinc-900/50 rounded-lg sm:rounded-xl flex justify-between items-center hover:bg-zinc-900 transition-colors">
                        <div>
                            <p class="text-xs sm:text-sm font-bold text-zinc-200 tracking-wide">${p.name}</p>
                            <p class="text-[8px] sm:text-[9px] text-zinc-500 uppercase tracking-widest font-bold mt-0.5">${p.set} â€¢ ${p.role}</p>
                        </div>
                        <span class="text-[10px] sm:text-xs font-display text-zinc-400 font-bold bg-zinc-950 px-2 sm:px-2.5 py-1 sm:py-1.5 rounded-md sm:rounded-lg border border-zinc-800 shadow-inner">â‚¹${p.basePrice || p.base}</span>
                    </div>
                `;
            });

            if (sold.length > 0) {
                upcomingHtml += `<div class="text-[9px] sm:text-[10px] text-cric-green font-bold uppercase tracking-widest mt-4 sm:mt-6 mb-2 sm:mb-3 px-1 border-t border-zinc-800/50 pt-3 sm:pt-5">Recently Sold (${sold.length})</div>`;
                [...sold].reverse().slice(0, 3).forEach(p => {
                    const owner = usersData.find(u => u.userId === p.ownerId);
                    const ownerName = owner ? owner.username : 'Unknown';
                    upcomingHtml += `
                        <div class="p-2.5 sm:p-3.5 border border-cric-green/20 bg-cric-green/5 rounded-lg sm:rounded-xl flex flex-col shadow-sm">
                            <div class="flex justify-between items-center mb-1.5 sm:mb-2">
                                <p class="text-xs sm:text-sm font-bold text-white tracking-wide">${p.name}</p>
                                <span class="text-[10px] sm:text-xs font-display font-black text-cric-gold bg-zinc-950/80 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-md sm:rounded-lg border border-zinc-800 shadow-inner">â‚¹${formatMoney(p.soldPrice)}</span>
                            </div>
                            <p class="text-[8px] sm:text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Bought by <span class="text-zinc-300 ml-1">${ownerName}</span></p>
                        </div>
                    `;
                });
            }

            if (unsold.length > 0) {
                upcomingHtml += `<div class="text-[9px] sm:text-[10px] text-zinc-500 font-bold uppercase tracking-widest mt-4 sm:mt-6 mb-2 sm:mb-3 px-1 border-t border-zinc-800/50 pt-3 sm:pt-5">Unsold (${unsold.length})</div>`;
                [...unsold].reverse().slice(0, 2).forEach(p => {
                    upcomingHtml += `
                        <div class="p-2.5 sm:p-3.5 border border-zinc-800/50 bg-zinc-900/30 rounded-lg sm:rounded-xl flex justify-between items-center opacity-50">
                            <p class="text-xs sm:text-sm font-bold text-zinc-500 line-through tracking-wide">${p.name}</p>
                            <span class="text-[8px] sm:text-[9px] text-zinc-600 font-black uppercase tracking-widest">Unsold</span>
                        </div>
                    `;
                });
            }
            
            ui.upcomingList.innerHTML = upcomingHtml;
        }

        function updateRoomUI() {
            if(!roomData) return;
            const isHost = usersData.find(u => u.userId === myUserDocId)?.role === 'admin';
            const currentPlayer = playersData.find(p => p.order === roomData.currentAuctionIndex);

            if (roomData.status === 'season') {
                screens.auction.classList.add('hidden'); screens.auction.classList.remove('flex');
                screens.season.classList.remove('hidden'); screens.season.classList.add('flex');
                seasonData = roomData.season || null;
                hideFloatingButtons();
                updateSeasonUI();
                return; 
            } else {
                screens.season.classList.add('hidden'); screens.season.classList.remove('flex');
                if (currentRoomId && screens.lobby.classList.contains('hidden')) {
                    screens.auction.classList.remove('hidden'); screens.auction.classList.add('flex');
                    showFloatingButtons();
                }
            }

            if (isHost && ui.btnHostUnsold) { 
                ui.btnHostUnsold.disabled = roomData.currentBidder ? true : false; 
                if (ui.btnHostSkip) ui.btnHostSkip.disabled = roomData.currentBidder ? true : false;
            }

            if (ui.formatBadge && roomData.format) {
                ui.formatBadge.innerText = roomData.format + " FORMAT";
                ui.formatBadge.classList.remove('hidden');
            }

            if(roomData.status === 'active' && roomData.timerEndTime > 0) {
                startTimer(roomData.timerEndTime);
                ui.roomStatus.innerText = "Live"; ui.roomStatus.className = "font-bold text-red-500 text-[9px] sm:text-xs lg:text-sm tracking-widest uppercase";
                ui.statusIndicator.className = "w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-red-500 shadow-[0_0_12px_#ef4444] animate-pulse";
                ui.timer.classList.remove('hidden');
                
                if(roomData.currentBidder !== myUserDocId) { ui.biddingControls.classList.remove('opacity-50', 'pointer-events-none'); } 
                else { ui.biddingControls.classList.add('opacity-50', 'pointer-events-none'); }
            } else {
                stopTimer(); ui.timer.classList.add('hidden'); ui.biddingControls.classList.add('opacity-50', 'pointer-events-none');
                
                if(roomData.status === 'waiting') {
                    ui.roomStatus.innerText = "Waiting..."; ui.roomStatus.className = "font-bold text-yellow-500 text-[9px] sm:text-xs lg:text-sm tracking-widest uppercase";
                    ui.statusIndicator.className = "w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-yellow-500 shadow-[0_0_12px_#eab308]";
                } else if(roomData.status === 'paused') {
                    ui.roomStatus.innerText = "Finalizing..."; ui.roomStatus.className = "font-bold text-orange-500 text-[9px] sm:text-xs lg:text-sm tracking-widest uppercase";
                    ui.statusIndicator.className = "w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-orange-500 shadow-[0_0_12px_#f97316]";
                } else if(roomData.status === 'finished') {
                    ui.roomStatus.innerText = "Completed"; ui.roomStatus.className = "font-bold text-emerald-500 text-[9px] sm:text-xs lg:text-sm tracking-widest uppercase";
                    ui.statusIndicator.className = "w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-emerald-500 shadow-[0_0_12px_#10b981]";
                    
                    if (isHost) {
                        const unsoldPlayersLeft = playersData.filter(p => p.status === 'unsold');
                        const teamsNeedingPlayers = usersData.filter(u => {
                            const count = playersData.filter(p => p.ownerId === u.userId).length;
                            return !u.kicked && !u.banned && count < 13;
                        });
                        
                        if (teamsNeedingPlayers.length > 0 && unsoldPlayersLeft.length > 0 && !draftModalDismissed) {
                            openDraftModal(teamsNeedingPlayers);
                        } else {
                            document.getElementById('draft-modal')?.classList.add('hidden');
                            if (!document.getElementById('btn-host-start-season')) {
                                const btn = document.createElement('button');
                                btn.id = 'btn-host-start-season';
                                btn.className = "bg-cric-accent hover:bg-blue-500 text-white font-bold px-2.5 sm:px-5 py-2 sm:py-3 rounded-lg sm:rounded-xl shadow-[0_0_20px_rgba(59,130,246,0.4)] flex-1 min-w-[100%] sm:min-w-[150px] transition-colors active:scale-95 text-[10px] sm:text-sm uppercase tracking-wider mt-2";
                                btn.innerText = "Simulate Season ðŸ†";
                                btn.onclick = initializeSeason;
                                ui.hostControls?.appendChild(btn);
                            }
                        }
                    }
                }
            }

            if(currentPlayer) {
                if(ui.playerName) ui.playerName.innerText = currentPlayer.name;
                if(ui.playerRole) ui.playerRole.innerText = currentPlayer.role;
                if(ui.playerCountry) ui.playerCountry.innerHTML = `<svg class="w-3.5 h-3.5 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9"></path></svg> ${currentPlayer.country}`;
                if(ui.playerBase) ui.playerBase.innerText = `â‚¹ ${formatMoney(currentPlayer.basePrice || currentPlayer.base)} Cr`;

                if (currentPlayer.set) {
                    if(ui.playerSet) {
                        ui.playerSet.innerText = currentPlayer.set + " SET";
                        ui.playerSet.classList.remove('hidden');
                    }
                } else {
                    if(ui.playerSet) ui.playerSet.classList.add('hidden');
                }
                
                if (playerStatsCache[currentPlayer.name]) {
                    renderPlayerAnalyticsUI(currentPlayer, playerStatsCache[currentPlayer.name]);
                } else {
                    const statRating = document.getElementById('ui-stat-rating');
                    if (statRating) {
                        statRating.innerText = "AI";
                        document.getElementById('ui-stat-predicted').innerText = "Fetching...";
                        document.getElementById('ui-stat-verdict').innerText = "Generating Stats...";
                        document.getElementById('ui-stat-matches').innerText = "-";
                        document.getElementById('ui-stat-v1').innerText = "-";
                        document.getElementById('ui-stat-v2').innerText = "-";
                        document.getElementById('ui-stat-form').innerHTML = '<div class="w-full text-center text-[10px] text-zinc-500 py-2 animate-pulse">Fetching Real Int\'l Data...</div>';
                    }
                    fetchRealPlayerStats(currentPlayer);
                }

                processPrefetchQueue();

                const displayBid = roomData.currentBid > 0 ? roomData.currentBid : (currentPlayer.basePrice || currentPlayer.base || 0);
                if(ui.currentBid) ui.currentBid.innerHTML = `â‚¹ ${formatMoney(displayBid)} <span class="text-xl sm:text-2xl lg:text-3xl text-zinc-500 font-bold tracking-normal">Cr</span>`;

                if(roomData.currentBidder) {
                    const bidder = usersData.find(u => u.userId === roomData.currentBidder);
                    if(ui.highestBidder) {
                        ui.highestBidder.innerText = bidder ? bidder.username : "Unknown";
                        ui.highestBidder.className = "font-bold text-cric-gold text-[10px] sm:text-sm lg:text-base truncate max-w-[100px] sm:max-w-[150px] lg:max-w-[200px]";
                    }
                    
                    if (lastBidderState !== roomData.currentBidder) {
                        if(ui.playerCard) { ui.playerCard.classList.add('glowing-bid'); setTimeout(() => ui.playerCard.classList.remove('glowing-bid'), 1000); }
                        lastBidderState = roomData.currentBidder;
                    }
                } else {
                    if(ui.highestBidder) {
                        ui.highestBidder.innerText = "Be the first!";
                        ui.highestBidder.className = "font-bold text-zinc-500 text-[10px] sm:text-sm lg:text-base truncate max-w-[100px] sm:max-w-[150px] lg:max-w-[200px]";
                    }
                    lastBidderState = null;
                }

                if(currentPlayer.status === 'sold') {
                    if(ui.soldOverlay) {
                        ui.soldOverlay.classList.remove('hidden'); ui.soldOverlay.classList.add('flex', 'animate-fade-in');
                        const owner = usersData.find(u => u.userId === currentPlayer.ownerId); const ownerName = owner ? owner.username : "Unknown";
                        if (!ui.soldOverlay.innerHTML.includes(currentPlayer.name)) {
                            ui.soldOverlay.innerHTML = `
                                <span class="hidden">${currentPlayer.name}</span>
                                <div class="animate-stamp flex flex-col items-center justify-center w-full">
                                    <h3 class="text-3xl sm:text-5xl lg:text-7xl font-display font-black text-cric-green mb-3 sm:mb-6 transform -rotate-12 uppercase tracking-widest drop-shadow-[0_0_30px_rgba(16,185,129,0.8)]">SOLD!</h3>
                                    <div class="bg-zinc-950/95 border border-zinc-800 rounded-xl sm:rounded-[2rem] p-3 sm:p-6 lg:p-8 w-[95%] sm:w-[90%] shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
                                        <p class="text-[8px] sm:text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-0.5 sm:mb-1">Purchased By</p>
                                        <p class="text-lg sm:text-2xl lg:text-3xl font-black text-cric-gold tracking-tight truncate w-full">${ownerName}</p>
                                        <div class="w-full h-px bg-zinc-800 my-2 sm:my-4"></div>
                                        <p class="text-[8px] sm:text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-0.5 sm:mb-1">Final Amount</p>
                                        <p class="text-2xl sm:text-4xl lg:text-5xl font-display font-black text-white">â‚¹ ${formatMoney(currentPlayer.soldPrice)} <span class="text-base sm:text-xl lg:text-2xl text-zinc-500">Cr</span></p>
                                    </div>
                                </div>
                            `;
                        }
                    }
                } else if(currentPlayer.status === 'unsold') {
                    if(ui.soldOverlay) {
                        ui.soldOverlay.classList.remove('hidden'); ui.soldOverlay.classList.add('flex', 'animate-fade-in');
                        if (!ui.soldOverlay.innerHTML.includes(currentPlayer.name)) {
                            ui.soldOverlay.innerHTML = `
                                <span class="hidden">${currentPlayer.name}</span>
                                <div class="animate-stamp flex flex-col items-center justify-center w-full">
                                    <h3 class="text-3xl sm:text-5xl lg:text-6xl font-display font-black text-zinc-400 mb-2 transform -rotate-12 uppercase tracking-widest drop-shadow-2xl">UNSOLD</h3>
                                </div>
                            `;
                        }
                    }
                } else {
                    if(ui.soldOverlay) { ui.soldOverlay.classList.add('hidden'); ui.soldOverlay.classList.remove('flex', 'animate-fade-in'); ui.soldOverlay.innerHTML = ''; }
                }
            } else {
                if(ui.playerName) ui.playerName.innerText = "Auction Finished"; 
                if(ui.playerRole) ui.playerRole.innerText = "---";
                if(ui.playerCountry) ui.playerCountry.innerHTML = `---`; 
                if(ui.playerBase) ui.playerBase.innerText = "---";
                if(ui.currentBid) ui.currentBid.innerHTML = "â‚¹ 0.00"; 
                if(ui.highestBidder) ui.highestBidder.innerText = "---";
                if(ui.playerSet) ui.playerSet.classList.add('hidden');
            }
        }

        function updateChatRecipients() {
            const select = document.getElementById('chat-recipient');
            if(!select) return;
            const currentVal = select.value;
            select.innerHTML = '<option value="all">Public Chat</option>';
            usersData.forEach(u => {
                if(u.userId !== myUserDocId && u._computedOnline) {
                    const opt = document.createElement('option');
                    opt.value = u.userId; opt.innerText = `Whisper: ${u.username}`; select.appendChild(opt);
                }
            });
            if([...select.options].some(o => o.value === currentVal)) select.value = currentVal;
        }

        window.placeBid = async (amount) => {
            if(!currentUser || !roomData) return;
            const me = usersData.find(u => u.userId === myUserDocId);
            const currentPlayer = playersData.find(p => p.order === roomData.currentAuctionIndex);
            if(!me || !currentPlayer || currentPlayer.status !== 'auctioning' || roomData.status !== 'active') return;

            const myPlayersCount = playersData.filter(p => p.ownerId === myUserDocId).length;
            if(myPlayersCount >= 18) return showToast("Roster full! Maximum 18 players allowed.");

            let newBid = roomData.currentBid === 0 ? (currentPlayer.basePrice || currentPlayer.base || 0) : parseFloat((roomData.currentBid + amount).toFixed(2));
            if(newBid > me.budget) return showToast("Insufficient Budget!");

            const now = getServerTime(); let newEndTime = roomData.timerEndTime;
            if((newEndTime - now) < 5000) newEndTime = now + 10000;

            try {
                await updateDoc(doc(getRoomsRef(), currentRoomId), { currentBid: newBid, currentBidder: myUserDocId, timerEndTime: newEndTime });
                document.getElementById('bidding-controls')?.classList.add('opacity-50', 'pointer-events-none');
            } catch(e) { console.error("Bid err", e); }
        };

        document.getElementById('btn-host-start')?.addEventListener('click', async () => {
            if(!currentUser || !roomData) return;
            const SET_ORDER = ["Marquee", "Batsmen", "Pacers", "Wicketkeepers", "All-Rounders", "Spinners"];
            const currentPlayer = playersData.find(p => p.order === roomData.currentAuctionIndex);

            if(currentPlayer && (currentPlayer.status === 'sold' || currentPlayer.status === 'unsold')) {
                let nextPlayer = null;
                for (const setName of SET_ORDER) {
                    const availableInSet = playersData.filter(p => p.set === setName && p.status === 'upcoming');
                    if (availableInSet.length > 0) {
                        nextPlayer = availableInSet[Math.floor(Math.random() * availableInSet.length)];
                        break;
                    }
                }

                // Fallback: If sets don't match strictly, pick ANY upcoming player
                if (!nextPlayer) {
                    const anyUpcoming = playersData.filter(p => p.status === 'upcoming');
                    if (anyUpcoming.length > 0) nextPlayer = anyUpcoming[0];
                }

                if(nextPlayer) {
                    await updateDoc(doc(getRoomsRef(), currentRoomId), { currentAuctionIndex: nextPlayer.order, status: 'active', currentBid: 0, currentBidder: null, timerEndTime: getServerTime() + (TIMER_SECONDS * 1000) });
                    await updateDoc(doc(getPlayersRef(), nextPlayer.playerId), { status: 'auctioning' });
                } else {
                    await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'finished' });
                    showToast("Auction Finished!");
                }
            } else if (!currentPlayer || currentPlayer.status === 'upcoming') {
                let firstPlayer = currentPlayer;
                if (!currentPlayer || currentPlayer.status !== 'upcoming') {
                    for (const setName of SET_ORDER) {
                        const availableInSet = playersData.filter(p => p.set === setName && p.status === 'upcoming');
                        if (availableInSet.length > 0) {
                            firstPlayer = availableInSet[Math.floor(Math.random() * availableInSet.length)];
                            break;
                        }
                    }
                    
                    // Fallback: If sets don't match strictly, pick ANY upcoming player
                    if (!firstPlayer) {
                        const anyUpcoming = playersData.filter(p => p.status === 'upcoming');
                        if (anyUpcoming.length > 0) firstPlayer = anyUpcoming[0];
                    }
                }
                if (firstPlayer) {
                    await updateDoc(doc(getRoomsRef(), currentRoomId), { currentAuctionIndex: firstPlayer.order, status: 'active', currentBid: 0, currentBidder: null, timerEndTime: getServerTime() + (TIMER_SECONDS * 1000) });
                    await updateDoc(doc(getPlayersRef(), firstPlayer.playerId), { status: 'auctioning' });
                }
            } else if (roomData.status === 'paused') {
                await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'active', timerEndTime: getServerTime() + (TIMER_SECONDS * 1000) });
            }
        });

        document.getElementById('btn-host-pause')?.addEventListener('click', async () => {
            if(!currentUser || !roomData) return;
            await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'paused', timerEndTime: 0 });
        });

        document.getElementById('btn-host-unsold')?.addEventListener('click', async () => {
            if(!currentUser || !roomData) return;
            if(roomData.currentBidder) return showToast("Cannot mark unsold: Bids exist!");
            const currentPlayer = playersData.find(p => p.order === roomData.currentAuctionIndex);
            if(currentPlayer) await markPlayerUnsold(currentPlayer.playerId);
        });

        document.getElementById('btn-host-skip')?.addEventListener('click', async () => {
            if(!currentUser || !roomData) return;
            if(roomData.currentBidder) return showToast("Cannot skip: Bids exist!");
            const currentPlayer = playersData.find(p => p.order === roomData.currentAuctionIndex);
            if(currentPlayer) {
                await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'paused', timerEndTime: 0 });
                await updateDoc(doc(getPlayersRef(), currentPlayer.playerId), { status: 'unsold' });
                setTimeout(() => {
                    const me = usersData.find(u => u.userId === myUserDocId);
                    if(me && me.role === 'admin') { const b = document.getElementById('btn-host-start'); if(b) b.click(); }
                }, 300);
            }
        });

        async function markPlayerSold(playerId, price, ownerDocId) {
            if(!currentUser) return;
            try {
                await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'paused', timerEndTime: 0 });
                await updateDoc(doc(getPlayersRef(), playerId), { status: 'sold', soldPrice: price, ownerId: ownerDocId });

                const ownerData = usersData.find(u => u.userId === ownerDocId);
                if(ownerData) await updateDoc(doc(getUsersRef(), ownerDocId), { budget: ownerData.budget - price });

                triggerConfetti();
                setTimeout(() => {
                    const me = usersData.find(u => u.userId === myUserDocId);
                    if(me && me.role === 'admin') { const b = document.getElementById('btn-host-start'); if(b) b.click(); }
                }, 5000);
            } catch(e) { console.error("Sold err:", e); }
        }

        async function markPlayerUnsold(playerId) {
            if(!currentUser) return;
            try {
                await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'paused', timerEndTime: 0 });
                await updateDoc(doc(getPlayersRef(), playerId), { status: 'unsold' });
                setTimeout(() => {
                    const me = usersData.find(u => u.userId === myUserDocId);
                    if(me && me.role === 'admin') { const b = document.getElementById('btn-host-start'); if(b) b.click(); }
                }, 3500);
            } catch(e) { console.error("Unsold err:", e); }
        }

        function startTimer(endTime) {
            stopTimer();
            timerInterval = setInterval(() => {
                const now = getServerTime(); const diff = Math.max(0, endTime - now); const seconds = Math.ceil(diff / 1000);
                if (ui.timer) {
                    ui.timer.innerText = seconds.toString().padStart(2, '0');
                    if(seconds <= 5) { ui.timer.classList.add('text-red-500'); ui.timer.classList.remove('text-white'); } else { ui.timer.classList.remove('text-red-500'); ui.timer.classList.add('text-white'); }
                }
                if(diff <= 0) { stopTimer(); handleTimerEnd(); }
            }, 100);
        }

        function stopTimer() { if(timerInterval) clearInterval(timerInterval); }

        async function handleTimerEnd() {
            const me = usersData.find(u => u.userId === myUserDocId);
            if(me && me.role === 'admin' && roomData.status === 'active') {
                const currentPlayer = playersData.find(p => p.order === roomData.currentAuctionIndex);
                if(!currentPlayer || currentPlayer.status !== 'auctioning') return;
                if(roomData.currentBidder) await markPlayerSold(currentPlayer.playerId, roomData.currentBid, roomData.currentBidder);
                else await markPlayerUnsold(currentPlayer.playerId);
            }
        }

        function triggerConfetti() {
            var duration = 3 * 1000; var animationEnd = Date.now() + duration;
            var defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 100 };
            function randomInRange(min, max) { return Math.random() * (max - min) + min; }
            var interval = setInterval(function() {
                var timeLeft = animationEnd - Date.now();
                if (timeLeft <= 0) return clearInterval(interval);
                var particleCount = 50 * (timeLeft / duration);
                confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } }));
                confetti(Object.assign({}, defaults, { particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } }));
            }, 250);
        }

        async function initializeSeason() {
            if (!currentUser || !roomData) return;
            const teams = usersData.filter(u => playersData.some(p => p.ownerId === u.userId));
            if (teams.length < 2) return showToast("Need at least 2 teams with players to start Season.");

            const matches = [];
            let matchId = 0;
            for (let i = 0; i < teams.length; i++) {
                for (let j = i + 1; j < teams.length; j++) {
                    matches.push({ id: matchId++, t1: teams[i].userId, t2: teams[j].userId, winner: null, summary: '', isPlayed: false, type: 'league' });
                    matches.push({ id: matchId++, t1: teams[j].userId, t2: teams[i].userId, winner: null, summary: '', isPlayed: false, type: 'league' });
                }
            }
            matches.sort(() => Math.random() - 0.5);

            const standings = {};
            teams.forEach(t => standings[t.userId] = { p: 0, w: 0, l: 0, pts: 0, nrr: 0, name: t.username });

            const stats = {};
            playersData.filter(p => p.ownerId).forEach(p => {
                stats[p.playerId] = { runs: 0, wickets: 0, injuredFor: 0, name: p.name, owner: p.ownerId, role: p.role, set: p.set };
            });

            const initialSeason = {
                phase: 'league',
                matches: matches,
                currentMatchIndex: 0,
                standings: standings,
                playerStats: stats,
                injuries: [],
                transferReady: []
            };

            try { await updateDoc(doc(getRoomsRef(), currentRoomId), { status: 'season', season: initialSeason }); } 
            catch (e) { console.error("Season Init Err", e); showToast("Failed to start season"); }
        }

        document.getElementById('btn-sim-next')?.addEventListener('click', async () => {
            if (!seasonData || roomData.status !== 'season') return;
            await simulateNextMatch();
        });

        document.getElementById('btn-sim-all')?.addEventListener('click', async () => {
            if (!seasonData || roomData.status !== 'season') return;
            for(let i=0; i<5; i++) {
                if (seasonData.phase === 'league' || seasonData.phase === 'playoffs') {
                    await simulateNextMatch();
                } else { break; }
            }
        });

        async function simulateNextMatch() {
            const sd = JSON.parse(JSON.stringify(seasonData)); 
            const mIdx = sd.currentMatchIndex;
            
            if (mIdx >= sd.matches.length) {
                if (sd.phase === 'league') return handleLeagueEnd(sd);
                if (sd.phase === 'playoffs') return handlePlayoffsEnd(sd);
                return;
            }

            if (sd.phase === 'league' && mIdx === Math.floor(sd.matches.filter(m=>m.type==='league').length / 2)) {
                sd.phase = 'transfer';
                sd.transferReady = [];
                sd.transferEndTime = Date.now() + (120 * 1000); // 2 minutes
                await updateDoc(doc(getRoomsRef(), currentRoomId), { season: sd });
                return;
            }

            const match = sd.matches[mIdx];
            const t1 = usersData.find(u => u.userId === match.t1);
            const t2 = usersData.find(u => u.userId === match.t2);

            const getBest11 = (teamId) => {
                let available = playersData.filter(p => p.ownerId === teamId && (!sd.playerStats[p.playerId] || sd.playerStats[p.playerId].injuredFor <= 0));
                // Sort by AI Rating descending to field the strongest possible 11
                available.sort((a, b) => {
                    const rA = parseFloat((playerStatsCache[a.name] || getFallbackAnalytics(a)).aiRating) || 5.0;
                    const rB = parseFloat((playerStatsCache[b.name] || getFallbackAnalytics(b)).aiRating) || 5.0;
                    return rB - rA;
                });
                return available.slice(0, 11);
            };

            const t1Players = getBest11(match.t1);
            const t2Players = getBest11(match.t2);

            Object.values(sd.playerStats).forEach(ps => { if(ps.injuredFor > 0) ps.injuredFor--; });

            const getStr = (teamPlayers) => teamPlayers.reduce((sum, p) => sum + parseFloat((playerStatsCache[p.name] || getFallbackAnalytics(p)).aiRating), 0);
            const str1 = getStr(t1Players) || 1;
            const str2 = getStr(t2Players) || 1;

            const roll1 = str1 * (0.8 + Math.random() * 0.4);
            const roll2 = str2 * (0.8 + Math.random() * 0.4);

            const winner = roll1 > roll2 ? match.t1 : match.t2;
            const loser = winner === match.t1 ? match.t2 : match.t1;
            
            match.winner = winner; match.isPlayed = true;

            const margin = Math.floor(Math.random() * 40) + 5;
            const isChasing = Math.random() > 0.5;
            if (isChasing) {
                const wktMargin = Math.floor(Math.random() * 7) + 2;
                match.summary = `${usersData.find(u=>u.userId===winner).username} won by ${wktMargin} wkts`;
            } else {
                match.summary = `${usersData.find(u=>u.userId===winner).username} won by ${margin} runs`;
            }

            sd.standings[winner].p++; sd.standings[winner].w++; sd.standings[winner].pts += 2;
            sd.standings[loser].p++; sd.standings[loser].l++;
            
            const nrrDiff = margin * 0.01;
            sd.standings[winner].nrr += nrrDiff; sd.standings[loser].nrr -= nrrDiff;

            distributeMatchStats(t1Players, t2Players, sd.playerStats, roomData.format);

            const checkInjury = (teamPlayers) => {
                if(Math.random() < 0.03 && teamPlayers.length > 0) {
                    const victim = teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
                    sd.playerStats[victim.playerId].injuredFor = 3; 
                    sd.injuries.unshift(`${victim.name} (${usersData.find(u=>u.userId===victim.ownerId).username}) injured for 3 matches.`);
                    if (sd.injuries.length > 10) sd.injuries.pop();
                }
            };
            checkInjury(t1Players); checkInjury(t2Players);

            sd.currentMatchIndex++;

            try { await updateDoc(doc(getRoomsRef(), currentRoomId), { season: sd }); } 
            catch(e) { console.error("Sim error", e); }
        }

        function distributeMatchStats(t1, t2, statsObj, format) {
            const distribute = (players, oppPlayers) => {
                let totalRuns = 140, maxRunsAdd = 80;
                let totalWkts = 4, maxWktsAdd = 7;

                if (format && format.startsWith('ODI')) {
                    totalRuns = 220; maxRunsAdd = 130;
                    totalWkts = 6; maxWktsAdd = 4;
                } else if (format && format.startsWith('TEST')) {
                    totalRuns = 400; maxRunsAdd = 250;
                    totalWkts = 12; maxWktsAdd = 8;
                }

                totalRuns += Math.floor(Math.random() * maxRunsAdd);
                totalWkts += Math.floor(Math.random() * maxWktsAdd);

                let runCandidates = players.filter(p => p.role.includes('Batsman') || p.role.includes('All-Rounder') || p.role.includes('Wicketkeeper'));
                if(runCandidates.length === 0) runCandidates = players;
                
                for(let r=0; r<totalRuns; r+=Math.floor(Math.random()*20)+5) {
                    if (runCandidates.length > 0) {
                        const batter = runCandidates[Math.floor(Math.random() * runCandidates.length)];
                        statsObj[batter.playerId].runs += Math.floor(Math.random() * 30) + 5;
                    }
                }

                let bowlCandidates = oppPlayers.filter(p => p.role.includes('Pacer') || p.role.includes('Spinner') || p.role.includes('All-Rounder'));
                if(bowlCandidates.length === 0) bowlCandidates = oppPlayers;

                for(let w=0; w<totalWkts; w++) {
                    if (bowlCandidates.length > 0) {
                        const bowler = bowlCandidates[Math.floor(Math.random() * bowlCandidates.length)];
                        statsObj[bowler.playerId].wickets += 1;
                    }
                }
            };
            distribute(t1, t2); distribute(t2, t1);
        }

        async function handleLeagueEnd(sd) {
            const teams = Object.entries(sd.standings).map(([id, data]) => ({ id, ...data }));
            teams.sort((a,b) => b.pts - a.pts || b.nrr - a.nrr);
            
            if (teams.length < 4) {
                sd.phase = 'finished';
                await updateDoc(doc(getRoomsRef(), currentRoomId), { season: sd });
                showToast("Season Over! Not enough teams for playoffs."); return;
            }

            const top4 = teams.slice(0, 4);
            const mStart = sd.matches.length;
            
            sd.matches.push({ id: mStart, t1: top4[0].id, t2: top4[1].id, type: 'Qualifier 1', winner: null, isPlayed: false, summary: '' });
            sd.matches.push({ id: mStart+1, t1: top4[2].id, t2: top4[3].id, type: 'Eliminator', winner: null, isPlayed: false, summary: '' });
            
            sd.phase = 'playoffs';
            try { await updateDoc(doc(getRoomsRef(), currentRoomId), { season: sd }); showToast("League Phase Ended! Playoffs Begin."); } 
            catch(e) { console.error(e); }
        }

        async function handlePlayoffsEnd(sd) {
            const pMatches = sd.matches.filter(m => m.type !== 'league');
            const unplayed = pMatches.find(m => !m.isPlayed);
            
            if (!unplayed) {
                const q1 = pMatches.find(m => m.type === 'Qualifier 1');
                const elim = pMatches.find(m => m.type === 'Eliminator');
                const q2 = pMatches.find(m => m.type === 'Qualifier 2');
                const final = pMatches.find(m => m.type === 'Final');

                if (q1 && q1.isPlayed && elim && elim.isPlayed && !q2) {
                    const q1Loser = q1.winner === q1.t1 ? q1.t2 : q1.t1;
                    sd.matches.push({ id: sd.matches.length, t1: q1Loser, t2: elim.winner, type: 'Qualifier 2', winner: null, isPlayed: false, summary: '' });
                } else if (q2 && q2.isPlayed && !final) {
                    sd.matches.push({ id: sd.matches.length, t1: q1.winner, t2: q2.winner, type: 'Final', winner: null, isPlayed: false, summary: '' });
                } else if (final && final.isPlayed) {
                    sd.phase = 'finished';
                    showToast(`ðŸ† ${sd.standings[final.winner].name} wins the Season!`);
                }
                await updateDoc(doc(getRoomsRef(), currentRoomId), { season: sd });
            }
        }

        function updateSeasonUI() {
            if (!seasonData) return;
            const isHost = usersData.find(u => u.userId === myUserDocId)?.role === 'admin';
            const hostControls = document.getElementById('season-host-controls');
            if (isHost && seasonData.phase !== 'finished') {
                if (hostControls) {
                    hostControls.classList.remove('hidden'); hostControls.classList.add('flex');
                    if (seasonData.phase === 'transfer') {
                        const totalTeams = Object.keys(seasonData.standings).length;
                        const readyCount = (seasonData.transferReady || []).length;
                        hostControls.innerHTML = `<span class="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mr-2 flex items-center">${readyCount}/${totalTeams} READY</span><button id="btn-resume-season" onclick="resumeSeason()" class="bg-cric-green hover:bg-emerald-400 text-zinc-950 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-[0_0_10px_rgba(16,185,129,0.5)] animate-pulse">Resume Season</button>`;
                    } else {
                        hostControls.innerHTML = `<button id="btn-sim-next" class="bg-white text-zinc-950 hover:bg-zinc-200 px-4 py-1.5 rounded-lg text-xs font-bold transition-all shadow-md">Simulate Match</button>
                                                  <button id="btn-sim-all" class="bg-zinc-800 text-white hover:bg-zinc-700 px-4 py-1.5 rounded-lg text-xs font-bold transition-all border border-zinc-700">Simulate 5</button>`;
                        document.getElementById('btn-sim-next')?.addEventListener('click', simulateNextMatch);
                        document.getElementById('btn-sim-all')?.addEventListener('click', async () => { for(let i=0;i<5;i++) await simulateNextMatch(); });
                    }
                }
            } else { if (hostControls) { hostControls.classList.add('hidden'); hostControls.classList.remove('flex'); } }

            const phaseEl = document.getElementById('ui-season-phase');
            if(phaseEl) phaseEl.innerText = seasonData.phase.toUpperCase();

            const ptBody = document.getElementById('season-points-table');
            if (ptBody) {
                ptBody.innerHTML = '';
                const sortedTeams = Object.entries(seasonData.standings).sort((a,b) => b[1].pts - a[1].pts || b[1].nrr - a[1].nrr);
                
                sortedTeams.forEach(([id, t], idx) => {
                    const isMe = id === myUserDocId;
                    const teamRating = getTeamRating(id);
                    const row = document.createElement('tr');
                    row.className = `border-b border-zinc-800/30 hover:bg-zinc-800/30 transition-colors ${isMe ? 'bg-cric-green/10 border-l-2 border-l-cric-green' : ''} ${idx < 4 ? 'bg-blue-500/5' : ''}`;
                    row.innerHTML = `
                        <td class="py-2.5 pl-2 font-bold text-white flex items-center gap-1.5">
                            <span class="text-[9px] text-zinc-500 w-3">${idx+1}</span> 
                            <span class="truncate max-w-[100px] sm:max-w-[150px]">${t.name}</span>
                            <span class="text-[8px] text-purple-400 bg-purple-900/40 px-1 rounded border border-purple-500/30 ml-0.5 whitespace-nowrap">â­ ${teamRating}</span>
                            ${idx < 4 ? '<span class="w-1.5 h-1.5 rounded-full bg-blue-500 shadow-[0_0_5px_rgba(59,130,246,0.8)]" title="Playoff Spot"></span>' : ''}
                        </td>
                        <td class="py-2.5 text-center text-zinc-400 font-medium">${t.p}</td>
                        <td class="py-2.5 text-center text-emerald-400 font-bold">${t.w}</td>
                        <td class="py-2.5 text-center text-red-400 font-bold">${t.l}</td>
                        <td class="py-2.5 text-center text-white font-black">${t.pts}</td>
                        <td class="py-2.5 text-right pr-2 text-zinc-400 font-display">${t.nrr > 0 ? '+'+t.nrr.toFixed(2) : t.nrr.toFixed(2)}</td>
                    `;
                    ptBody.appendChild(row);
                });
            }

            const pStatsArr = Object.values(seasonData.playerStats);
            const orangeList = document.getElementById('orange-cap-list');
            if (orangeList) {
                let orangeHtml = '';
                pStatsArr.sort((a,b) => b.runs - a.runs).slice(0,5).forEach((p, idx) => {
                    orangeHtml += `
                        <div class="flex justify-between items-center bg-zinc-900/50 border border-zinc-800 p-2 rounded-lg ${idx===0 ? 'border-orange-500/50 shadow-[0_0_10px_rgba(249,115,22,0.1)]' : ''}">
                            <div class="flex items-center gap-2 overflow-hidden"><span class="text-xs font-black ${idx===0 ? 'text-orange-500' : 'text-zinc-600'}">#${idx+1}</span>
                                <div class="truncate"><p class="text-sm font-bold text-zinc-200 truncate">${p.name}</p><p class="text-[9px] text-zinc-500 uppercase tracking-widest truncate">${usersData.find(u=>u.userId===p.owner)?.username}</p></div>
                            </div><span class="font-display font-black text-white ml-2 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">${p.runs}</span>
                        </div>`;
                });
                orangeList.innerHTML = orangeHtml;
            }

            const purpleList = document.getElementById('purple-cap-list');
            if (purpleList) {
                let purpleHtml = '';
                pStatsArr.sort((a,b) => b.wickets - a.wickets).slice(0,5).forEach((p, idx) => {
                    purpleHtml += `
                        <div class="flex justify-between items-center bg-zinc-900/50 border border-zinc-800 p-2 rounded-lg ${idx===0 ? 'border-purple-500/50 shadow-[0_0_10px_rgba(168,85,247,0.1)]' : ''}">
                            <div class="flex items-center gap-2 overflow-hidden"><span class="text-xs font-black ${idx===0 ? 'text-purple-500' : 'text-zinc-600'}">#${idx+1}</span>
                                <div class="truncate"><p class="text-sm font-bold text-zinc-200 truncate">${p.name}</p><p class="text-[9px] text-zinc-500 uppercase tracking-widest truncate">${usersData.find(u=>u.userId===p.owner)?.username}</p></div>
                            </div><span class="font-display font-black text-white ml-2 bg-zinc-950 px-2 py-0.5 rounded border border-zinc-800">${p.wickets}</span>
                        </div>`;
                });
                purpleList.innerHTML = purpleHtml;
            }

            const injList = document.getElementById('injury-list');
            if (injList) {
                let injHtml = '';
                if (seasonData.injuries && seasonData.injuries.length > 0) {
                    seasonData.injuries.forEach(inj => { injHtml += `<div class="bg-red-500/10 border border-red-500/20 text-red-400 text-[10px] p-2 rounded-md font-medium">âš ï¸ ${inj}</div>`; });
                } else { injHtml = `<p class="text-xs text-zinc-500 italic">No injuries reported yet.</p>`; }
                injList.innerHTML = injHtml;
            }

            const mySquadWrapper = document.getElementById('my-squad-stats-wrapper');
            const mySquadList = document.getElementById('my-squad-stats-list');
            if (mySquadWrapper && mySquadList) {
                if (seasonData.phase === 'transfer' || seasonData.phase === 'finished') {
                    mySquadWrapper.classList.remove('hidden');
                    let mySquadHtml = '';
                    
                    const myPlayers = playersData.filter(p => p.ownerId === myUserDocId);
                    const myStats = myPlayers.map(p => seasonData.playerStats[p.playerId]).filter(Boolean);
                    
                    myStats.sort((a,b) => (b.runs + b.wickets*20) - (a.runs + a.wickets*20));

                    myStats.forEach(stat => {
                        mySquadHtml += `
                            <div class="flex justify-between items-center bg-zinc-900/50 border border-zinc-800 p-2 rounded-lg">
                                <div class="truncate pr-2">
                                    <p class="text-xs font-bold text-white truncate">${stat.name}</p>
                                    <p class="text-[9px] text-zinc-500 uppercase">${stat.role}</p>
                                </div>
                                <div class="flex gap-1.5 shrink-0 text-[10px] font-bold text-zinc-300">
                                    <span class="bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">${stat.runs} R</span>
                                    <span class="bg-zinc-800 px-1.5 py-0.5 rounded border border-zinc-700">${stat.wickets} W</span>
                                </div>
                            </div>`;
                    });
                    if(myStats.length === 0) mySquadHtml = '<p class="text-xs text-zinc-500 italic p-2">No players in your squad.</p>';
                    mySquadList.innerHTML = mySquadHtml;
                } else {
                    mySquadWrapper.classList.add('hidden');
                }
            }

            const currentMatchDiv = document.getElementById('current-match-display');
            const resultsList = document.getElementById('season-results-list');
            let resultsHtml = '';

            const currentMatch = seasonData.matches[seasonData.currentMatchIndex];
            
            if (currentMatchDiv) {
                if (seasonData.phase === 'transfer') {
                    const endTime = seasonData.transferEndTime || (Date.now() + 120000);
                    
                    if (!transferTimerInterval) {
                        transferTimerInterval = setInterval(() => {
                            const now = Date.now();
                            const diff = Math.max(0, endTime - now);
                            const secs = Math.ceil(diff / 1000);
                            const mins = Math.floor(secs / 60);
                            const remSecs = secs % 60;
                            const timeStr = `${mins}:${remSecs.toString().padStart(2, '0')}`;
                            
                            const timerEl = document.getElementById('transfer-countdown-clock');
                            if (timerEl) timerEl.innerText = timeStr;
                            
                            if (diff <= 0) {
                                clearInterval(transferTimerInterval);
                                transferTimerInterval = null;
                                if (isHost && document.getElementById('btn-resume-season')) {
                                    document.getElementById('btn-resume-season').click();
                                }
                            }
                        }, 1000);
                    }

                    const totalTeams = Object.keys(seasonData.standings).length;
                    const readyCount = (seasonData.transferReady || []).length;
                    const isReady = (seasonData.transferReady || []).includes(myUserDocId);
                    
                    let actionsHtml = '';
                    if (isReady) {
                        actionsHtml = `<p class="text-emerald-400 font-bold text-sm bg-emerald-500/10 border border-emerald-500/20 py-2 rounded-xl mt-4">Transfers Completed! Waiting for others...</p>`;
                    } else {
                        actionsHtml = `
                            <div class="flex flex-col sm:flex-row gap-3 justify-center w-full mt-4">
                                <button onclick="openTransferWindow()" class="bg-blue-500 hover:bg-blue-400 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-[0_0_15px_rgba(59,130,246,0.5)] active:scale-95">Open Transfer Desk</button>
                                <button onclick="markTransferReady()" class="bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 px-6 py-3 rounded-xl font-bold transition-all active:scale-95">Done with Transfers</button>
                            </div>
                        `;
                    }

                    currentMatchDiv.innerHTML = `
                        <div class="bg-blue-900/20 border border-blue-500/40 rounded-2xl p-6 text-center shadow-[0_0_30px_rgba(59,130,246,0.15)] animate-pulse-fast flex flex-col items-center">
                            <span class="text-4xl mb-2 block">ðŸ”„</span><h3 class="text-xl font-display font-black text-blue-400 uppercase tracking-widest mb-1">Transfer Window Open</h3>
                            <p class="text-zinc-400 text-sm mb-4">Teams are trading players. (${readyCount}/${totalTeams} Ready)</p>
                            <div class="bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 mb-2">
                                <p class="text-[10px] text-zinc-500 uppercase tracking-widest font-bold mb-1">Time Remaining</p>
                                <p id="transfer-countdown-clock" class="text-2xl font-display font-black text-red-500">--:--</p>
                            </div>
                            ${actionsHtml}
                            ${isHost ? '<p class="text-[10px] text-zinc-500 mt-4 uppercase tracking-widest font-bold">Host: Auto-resumes when timer ends.</p>' : ''}
                        </div>`;
                } else {
                    if (transferTimerInterval) { clearInterval(transferTimerInterval); transferTimerInterval = null; }
                    if (currentMatch && seasonData.phase !== 'finished') {
                        const t1Name = usersData.find(u=>u.userId===currentMatch.t1)?.username;
                        const t2Name = usersData.find(u=>u.userId===currentMatch.t2)?.username;
                        const matchType = currentMatch.type === 'league' ? `Match ${seasonData.currentMatchIndex + 1}` : currentMatch.type;
                        
                        currentMatchDiv.innerHTML = `
                            <div class="bg-gradient-to-b from-zinc-900 to-zinc-950 border border-zinc-700/50 rounded-2xl p-6 shadow-2xl relative overflow-hidden">
                                <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-red-500 to-transparent opacity-50"></div>
                                <p class="text-center text-[10px] font-bold text-red-500 uppercase tracking-widest mb-4">UP NEXT â€¢ ${matchType}</p>
                                <div class="flex justify-between items-center gap-4">
                                    <div class="flex-1 text-center"><div class="w-12 h-12 sm:w-16 sm:h-16 mx-auto bg-zinc-800 rounded-full flex items-center justify-center font-display font-bold text-xl sm:text-2xl text-zinc-300 border border-zinc-700 shadow-inner mb-2">${t1Name?.charAt(0) || '?'}</div><p class="font-bold text-white text-sm sm:text-base truncate">${t1Name || '?'}</p></div>
                                    <div class="shrink-0 text-center"><span class="text-xs sm:text-sm font-black italic text-zinc-600 px-3 py-1 bg-zinc-950 rounded-full border border-zinc-800">VS</span></div>
                                    <div class="flex-1 text-center"><div class="w-12 h-12 sm:w-16 sm:h-16 mx-auto bg-zinc-800 rounded-full flex items-center justify-center font-display font-bold text-xl sm:text-2xl text-zinc-300 border border-zinc-700 shadow-inner mb-2">${t2Name?.charAt(0) || '?'}</div><p class="font-bold text-white text-sm sm:text-base truncate">${t2Name || '?'}</p></div>
                                </div>
                            </div>`;
                    } else if (seasonData.phase === 'finished') {
                        const finalMatch = seasonData.matches.find(m => m.type === 'Final');
                        const winnerName = usersData.find(u=>u.userId===finalMatch?.winner)?.username;
                        currentMatchDiv.innerHTML = `
                            <div class="bg-gradient-to-b from-emerald-900/30 to-zinc-950 border border-emerald-500/40 rounded-2xl p-6 text-center shadow-[0_0_40px_rgba(16,185,129,0.2)]">
                                <span class="text-5xl mb-3 block animate-float">ðŸ†</span><h3 class="text-2xl font-display font-black text-white mb-1">Season Champions</h3><p class="text-xl font-bold text-emerald-400">${winnerName || 'Unknown'}</p>
                            </div>`;
                    }
                }
            }

            if (resultsList) {
                const playedMatches = seasonData.matches.filter(m => m.isPlayed).reverse();
                playedMatches.forEach(m => {
                    const t1 = usersData.find(u=>u.userId===m.t1); const t2 = usersData.find(u=>u.userId===m.t2);
                    if(!t1 || !t2) return;
                    const isT1Winner = m.winner === m.t1;
                    
                    resultsHtml += `
                        <div class="bg-zinc-900/40 border border-zinc-800/80 rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm">
                            <div class="flex items-center justify-center sm:justify-start gap-3 flex-1">
                                <span class="${isT1Winner ? 'text-white font-bold' : 'text-zinc-500'} text-right flex-1 truncate">${t1.username}</span>
                                <span class="text-[10px] font-black text-zinc-700 bg-zinc-950 px-1.5 py-0.5 rounded border border-zinc-800">VS</span>
                                <span class="${!isT1Winner ? 'text-white font-bold' : 'text-zinc-500'} text-left flex-1 truncate">${t2.username}</span>
                            </div>
                            <div class="text-[10px] sm:text-xs text-cric-green font-bold bg-cric-green/10 border border-cric-green/20 px-2.5 py-1 rounded-md text-center shrink-0">${m.summary}</div>
                        </div>`;
                });
                resultsList.innerHTML = resultsHtml;
            }
        }

        window.openTransferWindow = () => {
            hideFloatingButtons();
            selectedTransferRelease = null; selectedTransferSign = null;
            const confirmBtn = document.getElementById('btn-confirm-transfer');
            if(confirmBtn) confirmBtn.disabled = true;
            
            renderTransferLists();
            const modal = document.getElementById('transfer-modal');
            if(modal) {
                modal.classList.remove('hidden');
                setTimeout(() => modal.classList.remove('opacity-0'), 10);
            }
        };

        window.closeTransferWindow = () => {
            const modal = document.getElementById('transfer-modal');
            if(modal) {
                modal.classList.add('opacity-0');
                setTimeout(() => {
                    modal.classList.add('hidden');
                    showFloatingButtons();
                }, 300);
            }
        };

        window.markTransferReady = async () => {
            if (!currentUser || !roomData || !seasonData) return;
            try {
                let newSd = JSON.parse(JSON.stringify(seasonData));
                if (!newSd.transferReady) newSd.transferReady = [];
                if (!newSd.transferReady.includes(myUserDocId)) {
                    newSd.transferReady.push(myUserDocId);
                    await updateDoc(doc(getRoomsRef(), currentRoomId), { season: newSd });
                    showToast("Locked in. Waiting for others!");
                }
            } catch(e) { console.error(e); showToast("Failed to lock transfers."); }
        };

        window.resumeSeason = async () => {
            if (!currentUser || !roomData) return;
            try {
                let newSd = JSON.parse(JSON.stringify(seasonData));
                newSd.phase = 'league';
                await updateDoc(doc(getRoomsRef(), currentRoomId), { season: newSd });
            } catch(e) { console.error(e); showToast("Failed to resume season."); }
        };

        function renderTransferLists() {
            const myPlayersList = document.getElementById('transfer-my-players');
            const unsoldList = document.getElementById('transfer-unsold-players');
            if(!myPlayersList || !unsoldList) return;
            
            myPlayersList.innerHTML = ''; unsoldList.innerHTML = '';

            const myPlayers = playersData.filter(p => p.ownerId === myUserDocId);
            const unsoldPlayers = playersData.filter(p => p.status === 'unsold');

            myPlayers.forEach(p => {
                const stat = seasonData.playerStats[p.playerId];
                const isInj = stat && stat.injuredFor > 0;
                const div = document.createElement('div');
                div.className = `p-2.5 rounded-lg border cursor-pointer transition-all flex justify-between items-center ${selectedTransferRelease === p.playerId ? 'border-red-500 bg-red-500/20' : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'}`;
                div.innerHTML = `<div><p class="text-sm font-bold text-white">${p.name}</p><p class="text-[9px] text-zinc-500 uppercase">${p.role}</p></div>${isInj ? '<span class="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded font-bold">INJURED</span>' : ''}`;
                div.onclick = () => { selectedTransferRelease = p.playerId; renderTransferLists(); checkTransferValid(); };
                myPlayersList.appendChild(div);
            });
            if(myPlayers.length === 0) myPlayersList.innerHTML = '<p class="text-xs text-zinc-500 italic p-2">No players owned.</p>';

            unsoldPlayers.forEach(p => {
                const div = document.createElement('div');
                div.className = `p-2.5 rounded-lg border cursor-pointer transition-all flex justify-between items-center ${selectedTransferSign === p.playerId ? 'border-cric-green bg-cric-green/20' : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'}`;
                div.innerHTML = `<div><p class="text-sm font-bold text-white">${p.name}</p><p class="text-[9px] text-zinc-500 uppercase">${p.role}</p></div><span class="font-display font-black text-xs text-zinc-400">â‚¹${p.basePrice || p.base}</span>`;
                div.onclick = () => { selectedTransferSign = p.playerId; renderTransferLists(); checkTransferValid(); };
                unsoldList.appendChild(div);
            });
            if(unsoldPlayers.length === 0) unsoldList.innerHTML = '<p class="text-xs text-zinc-500 italic p-2">No unsold players available.</p>';
        }

        function checkTransferValid() { 
            const btn = document.getElementById('btn-confirm-transfer');
            if(btn) btn.disabled = !(selectedTransferRelease && selectedTransferSign); 
        }

        document.getElementById('btn-confirm-transfer')?.addEventListener('click', async () => {
            if (!selectedTransferRelease || !selectedTransferSign) return;
            const releaseP = playersData.find(p => p.playerId === selectedTransferRelease); 
            const signP = playersData.find(p => p.playerId === selectedTransferSign);
            const me = usersData.find(u => u.userId === myUserDocId);
            const budgetDiff = (releaseP.basePrice || releaseP.base) - (signP.basePrice || signP.base);
            if (me.budget + budgetDiff < 0) return showToast("Insufficient budget for this swap.");

            try {
                const batch = writeBatch(db);
                batch.update(doc(getPlayersRef(), releaseP.playerId), { status: 'unsold', ownerId: null, soldPrice: null });
                batch.update(doc(getPlayersRef(), signP.playerId), { status: 'sold', ownerId: myUserDocId, soldPrice: (signP.basePrice || signP.base) });
                batch.update(doc(getUsersRef(), myUserDocId), { budget: me.budget + budgetDiff });
                
                let newSd = JSON.parse(JSON.stringify(seasonData));
                newSd.playerStats[signP.playerId] = { runs: 0, wickets: 0, injuredFor: 0, name: signP.name, owner: myUserDocId, role: signP.role, set: signP.set };
                newSd.injuries.unshift(`${me.username} signed ${signP.name} replacing ${releaseP.name}.`);
                
                batch.update(doc(getRoomsRef(), currentRoomId), { season: newSd });
                await batch.commit();

                document.getElementById('transfer-modal').classList.add('hidden');
                showFloatingButtons();
                showToast("Transfer Successful!");
            } catch(e) { console.error("Transfer Error", e); showToast("Failed to process transfer."); }
        });

        let selectedDraftPlayer = null;
        window.openDraftModal = (teamsNeedingPlayers) => {
            const modal = document.getElementById('draft-modal');
            const select = document.getElementById('draft-team-select');
            const list = document.getElementById('draft-unsold-players');
            const btnClose = document.getElementById('btn-close-draft');
            
            const currentSelectedTeam = select.value;
            select.innerHTML = '';
            
            teamsNeedingPlayers.forEach(t => {
                const count = playersData.filter(p => p.ownerId === t.userId).length;
                const opt = document.createElement('option');
                opt.value = t.userId;
                opt.innerText = `${t.username} (${count}/13 min players)`;
                select.appendChild(opt);
            });
            
            if (currentSelectedTeam && [...select.options].some(o => o.value === currentSelectedTeam)) {
                select.value = currentSelectedTeam;
            }

            const unsoldPlayers = playersData.filter(p => p.status === 'unsold');
            list.innerHTML = '';
            unsoldPlayers.forEach(p => {
                const div = document.createElement('div');
                div.className = `p-2.5 rounded-lg border cursor-pointer transition-all flex justify-between items-center ${selectedDraftPlayer === p.playerId ? 'border-cric-green bg-cric-green/20' : 'border-zinc-800 bg-zinc-900 hover:border-zinc-600'}`;
                div.innerHTML = `<div><p class="text-sm font-bold text-white">${p.name}</p><p class="text-[9px] text-zinc-500 uppercase">${p.role}</p></div><span class="font-display font-black text-xs text-zinc-400">â‚¹${p.basePrice || p.base}</span>`;
                div.onclick = () => { selectedDraftPlayer = p.playerId; openDraftModal(teamsNeedingPlayers); checkDraftValid(); };
                list.appendChild(div);
            });
            
            if(unsoldPlayers.length === 0) list.innerHTML = '<p class="text-xs text-zinc-500 italic p-2">No unsold players available.</p>';
            
            btnClose.disabled = false;
            if (teamsNeedingPlayers.length === 0 || unsoldPlayers.length === 0) btnClose.innerText = "Done - Proceed to Season";
            else btnClose.innerText = "Skip Draft";
            
            modal.classList.remove('hidden');
            setTimeout(() => { modal.classList.remove('opacity-0'); modal.querySelector('.glass-panel').classList.remove('scale-95'); }, 10);
            checkDraftValid();
        };

        window.checkDraftValid = () => {
            const btn = document.getElementById('btn-assign-draft');
            if(btn) btn.disabled = !selectedDraftPlayer || !document.getElementById('draft-team-select').value;
        };

        document.getElementById('btn-assign-draft')?.addEventListener('click', async () => {
            const teamId = document.getElementById('draft-team-select').value;
            const playerId = selectedDraftPlayer;
            if (!teamId || !playerId) return;
            
            const player = playersData.find(p => p.playerId === playerId);
            const team = usersData.find(u => u.userId === teamId);
            if (!player || !team) return;

            const teamPlayersCount = playersData.filter(p => p.ownerId === teamId).length;
            if (teamPlayersCount >= 18) return showToast("Team roster full!");

            try {
                document.getElementById('btn-assign-draft').disabled = true;
                const batch = writeBatch(db);
                const price = player.basePrice || player.base || 0;
                batch.update(doc(getPlayersRef(), playerId), { status: 'sold', ownerId: teamId, soldPrice: price });
                batch.update(doc(getUsersRef(), teamId), { budget: team.budget - price });
                await batch.commit();
                selectedDraftPlayer = null;
                showToast(`${player.name} assigned to ${team.username}`);
            } catch(e) {
                console.error("Draft err", e);
                showToast("Assignment failed");
            }
        });

        document.getElementById('btn-close-draft')?.addEventListener('click', () => {
            draftModalDismissed = true;
            const modal = document.getElementById('draft-modal');
            modal.classList.add('opacity-0');
            modal.querySelector('.glass-panel').classList.add('scale-95');
            setTimeout(() => modal.classList.add('hidden'), 300);
            updateRoomUI();
        });

        function updateChatUI() {
            const container = document.getElementById('chat-messages'); if (!container) return;
            const chatPanel = document.getElementById('chat-panel');
            const isHiddenDesktop = chatPanel.classList.contains('hidden');
            
            if (chatMessages.length > lastViewedMessageCount) {
                if (isHiddenDesktop) {
                    const unread = chatMessages.length - lastViewedMessageCount;
                    const badge = document.getElementById('chat-badge'); 
                    if(badge) { badge.innerText = unread > 9 ? '9+' : unread; badge.classList.remove('hidden'); badge.classList.add('flex'); }
                } else { lastViewedMessageCount = chatMessages.length; }
            }
            
            let chatHtml = '';
            chatMessages.forEach(msg => {
                const isMe = msg.senderId === myUserDocId;
                const isWhisper = msg.receiverId !== 'all';
                const isWhisperToMe = isWhisper && msg.receiverId === myUserDocId;
                
                let labelText = isMe ? 'You' : msg.senderName;
                if (isWhisper) { labelText = isWhisperToMe ? `Whisper from ${msg.senderName}` : `Whisper to ${msg.receiverName}`; }
                
                let bubbleClasses = isMe 
                    ? 'bg-zinc-800 text-white rounded-xl sm:rounded-[1.25rem] rounded-tr-sm border border-zinc-700' 
                    : 'bg-zinc-900 text-white rounded-xl sm:rounded-[1.25rem] rounded-tl-sm border border-zinc-800';
                    
                if (isWhisper) {
                    bubbleClasses = isMe
                        ? 'bg-purple-900/80 text-white rounded-xl sm:rounded-[1.25rem] rounded-tr-sm border border-purple-500/50 shadow-[0_0_15px_rgba(168,85,247,0.15)]'
                        : 'bg-purple-950/80 text-purple-100 rounded-xl sm:rounded-[1.25rem] rounded-tl-sm border border-purple-500/30';
                }
                
                chatHtml += `<div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} w-full mb-3 sm:mb-4"><span class="text-[8px] sm:text-[9px] font-bold uppercase tracking-widest ${isWhisper ? 'text-purple-400' : 'text-zinc-500'} mb-1 sm:mb-1.5 mx-1">${labelText}</span><div class="px-3 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm shadow-md inline-block max-w-[85%] break-words leading-relaxed ${bubbleClasses}">${msg.text.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div></div>`;
            });
            container.innerHTML = chatHtml;
            scrollToBottomChat();
        }

        function scrollToBottomChat() { const container = document.getElementById('chat-messages'); if(container) { container.scrollTop = container.scrollHeight; } }

        window.toggleDesktopChat = () => {
            const panel = document.getElementById('chat-panel');
            if(panel.classList.contains('hidden')) {
                hideFloatingButtons();
                panel.classList.remove('hidden'); panel.classList.add('flex');
                const badge = document.getElementById('chat-badge');
                if(badge) { badge.classList.add('hidden'); badge.classList.remove('flex'); }
                lastViewedMessageCount = chatMessages.length;
                setTimeout(scrollToBottomChat, 100);
            } else { 
                panel.classList.add('hidden'); panel.classList.remove('flex'); 
                showFloatingButtons();
            }
        };

        window.sendChatMessage = async () => {
            const input = document.getElementById('chat-input'); const text = input.value.trim();
            if(!text || !currentUser || !currentRoomId) return;
            const select = document.getElementById('chat-recipient');
            const receiverId = select.value; const receiverName = receiverId === 'all' ? 'Everyone' : select.options[select.selectedIndex].text.replace('Whisper: ', '');
            const me = usersData.find(u => u.userId === myUserDocId); if(!me) return;
            
            try {
                input.value = ''; 
                const msgRef = doc(getChatRef(currentRoomId));
                await setDoc(msgRef, { id: msgRef.id, roomId: currentRoomId, senderId: myUserDocId, senderName: me.username, receiverId: receiverId, receiverName: receiverName, text: text, timestamp: Date.now() });
                document.getElementById('emoji-picker')?.classList.add('hidden');
            } catch(e) { console.error("Chat send error:", e); showToast("Failed to send message"); }
        };

        async function initVoiceChat() {
            try {
                if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                    console.warn("MediaDevices API not available (requires HTTPS).");
                    showToast("Camera/Mic access requires a secure HTTPS connection.");
                    return;
                }
                try { 
                    localStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { echoCancellation: true, noiseSuppression: true }, 
                        video: { facingMode: { ideal: "user" } } 
                    }); 
                } catch (camErr) { 
                    console.warn("Camera failed, trying audio only.", camErr); 
                    try {
                        localStream = await navigator.mediaDevices.getUserMedia({ 
                            audio: { echoCancellation: true, noiseSuppression: true }, 
                            video: false 
                        }); 
                    } catch (audioErr) {
                        console.warn("Audio also failed.", audioErr);
                        showToast("Mic access denied. Please check browser permissions.");
                        return;
                    }
                }
                
                const localVid = document.getElementById('local-video'); if (localVid && localStream) localVid.srcObject = localStream;
                if (localStream) {
                    localStream.getAudioTracks().forEach(track => track.enabled = false); 
                    localStream.getVideoTracks().forEach(track => track.enabled = false);
                }

                try {
                    peer = new Peer({
                        config: {
                            iceServers: [
                                { urls: 'stun:stun.l.google.com:19302' },
                                { urls: 'stun:stun1.l.google.com:19302' },
                                { urls: 'stun:stun2.l.google.com:19302' },
                                { urls: 'stun:stun3.l.google.com:19302' },
                                { 
                                    urls: 'turn:openrelay.metered.ca:80',
                                    username: 'openrelayproject',
                                    credential: 'openrelayproject'
                                },
                                { 
                                    urls: 'turn:openrelay.metered.ca:443',
                                    username: 'openrelayproject',
                                    credential: 'openrelayproject'
                                },
                                { 
                                    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                                    username: 'openrelayproject',
                                    credential: 'openrelayproject'
                                }
                            ]
                        }
                    });
                    peer.on('open', (id) => { myPeerId = id; if (myUserDocId) { updateDoc(doc(getUsersRef(), myUserDocId), { peerId: myPeerId }).catch(console.error); } });
                    peer.on('call', (call) => { call.answer(localStream); handleCallStream(call); });
                    peer.on('error', (err) => { if (err.type === 'network' || String(err).includes('SecurityError') || String(err).includes('WebSocket')) { console.warn("PeerJS security error (HTTPS needed)."); } else if (err.type !== 'peer-unavailable') { console.warn("PeerJS:", err); } });
                } catch (peerErr) { console.error("PeerJS init failed:", peerErr); }
            } catch (err) { console.error("Media err:", err); }
        }

        function makeCall(remotePeerId) {
            if (!localStream || !peer || peer.destroyed) return;
            try { const call = peer.call(remotePeerId, localStream); if (call) handleCallStream(call); } 
            catch(e) { console.warn("Call failed:", e); }
        }

        function handleCallStream(call) {
            connectedPeers.add(call.peer);
            call.on('stream', (remoteStream) => { activeStreams.set(call.peer, remoteStream); updateVideoGallery(); });
            call.on('close', () => { connectedPeers.delete(call.peer); activeStreams.delete(call.peer); updateVideoGallery(); });
        }

        document.getElementById('btn-mic')?.addEventListener('click', () => {
            if (!localStream || localStream.getAudioTracks().length === 0) return showToast("Mic unavailable!");
            isMicMuted = !isMicMuted; localStream.getAudioTracks().forEach(t => t.enabled = !isMicMuted);
            const btn = document.getElementById('btn-mic'); const iconOn = document.getElementById('icon-mic-on'); const iconOff = document.getElementById('icon-mic-off');
            if (isMicMuted) { iconOn.classList.add('hidden'); iconOff.classList.remove('hidden'); btn.classList.add('bg-red-500/10', 'text-red-400'); btn.classList.remove('bg-cric-green/20', 'text-cric-green'); } 
            else { iconOn.classList.remove('hidden'); iconOff.classList.add('hidden'); btn.classList.remove('bg-red-500/10', 'text-red-400'); btn.classList.add('bg-cric-green/20', 'text-cric-green'); }
        });

        document.getElementById('btn-video')?.addEventListener('click', async () => {
            if (!localStream) return;
            if (localStream.getVideoTracks().length === 0) {
                try {
                    const vidStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
                    localStream.addTrack(vidStream.getVideoTracks()[0]);
                    const localVid = document.getElementById('local-video'); if (localVid) localVid.srcObject = localStream;
                } catch (e) { return showToast("Camera denied!"); }
            }
            isVideoMuted = !isVideoMuted; localStream.getVideoTracks().forEach(t => t.enabled = !isVideoMuted);
            const btn = document.getElementById('btn-video'); const iconOn = document.getElementById('icon-video-on'); const iconOff = document.getElementById('icon-video-off'); const localVid = document.getElementById('local-video');
            if (isVideoMuted) {
                iconOn.classList.add('hidden'); iconOff.classList.remove('hidden'); btn.classList.add('bg-red-500/10', 'text-red-400'); btn.classList.remove('bg-cric-green/20', 'text-cric-green');
                if(localVid) { localVid.classList.replace('opacity-100', 'opacity-30'); localVid.classList.add('grayscale'); }
            } else {
                iconOn.classList.remove('hidden'); iconOff.classList.add('hidden'); btn.classList.remove('bg-red-500/10', 'text-red-400'); btn.classList.add('bg-cric-green/20', 'text-cric-green');
                if(localVid) { localVid.classList.replace('opacity-30', 'opacity-100'); localVid.classList.remove('grayscale'); }
            }
        });

        setTimeout(() => {
            const chatInput = document.getElementById('chat-input'); const sendBtn = document.getElementById('btn-send-chat');
            const emojiToggle = document.getElementById('btn-emoji-toggle'); const emojiPicker = document.getElementById('emoji-picker'); const emojiGrid = document.getElementById('emoji-grid');
            if(chatInput && sendBtn) { chatInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') sendChatMessage(); }); sendBtn.addEventListener('click', sendChatMessage); }

            const emojis = ['ðŸ˜€', 'ðŸ˜‚', 'ðŸ˜Ž', 'ðŸ˜', 'ðŸ˜Š', 'ðŸ™Œ', 'ðŸ‘', 'ðŸ”¥', 'ðŸŽ‰', 'ðŸ’¯', 'ðŸ', 'ðŸ†', 'ðŸ’°', 'ðŸš€', 'ðŸ‘€', 'ðŸ¤¯', 'ðŸ˜±', 'ðŸ‘', 'ðŸ¤', 'ðŸ’ª', 'ðŸ¤”', 'ðŸ¤¨', 'ðŸ¤«', 'ðŸ¥±', 'ðŸ¥º', 'ðŸ˜¡', 'ðŸ¤¬', 'ðŸ¤®', 'ðŸ’”', 'ðŸ“ˆ'];
            if (emojiGrid) {
                emojis.forEach(emoji => {
                    const btn = document.createElement('button'); btn.className = "hover:bg-zinc-700 rounded p-1.5 transition-colors flex items-center justify-center"; btn.innerText = emoji;
                    btn.onclick = (e) => { e.preventDefault(); if (chatInput) { chatInput.value += emoji; chatInput.focus(); } };
                    emojiGrid.appendChild(btn);
                });
            }

            if (emojiToggle && emojiPicker) {
                emojiToggle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); emojiPicker.classList.toggle('hidden'); });
                document.addEventListener('click', (e) => { if (!emojiPicker.contains(e.target) && !emojiToggle.contains(e.target)) { emojiPicker.classList.add('hidden'); } });
                emojiPicker.addEventListener('click', (e) => { e.stopPropagation(); });
            }
        }, 1000);
