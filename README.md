<div align="center">
  <h1>🏏 CricBid</h1>
  <p><strong>Elite Multiplayer Cricket Auction Platform</strong></p>
  
  [![Live Demo](https://img.shields.io/badge/Live-Demo-brightgreen.svg?style=for-the-badge)](https://anirudhrao-24.github.io/CricBid/)
</div>

---

## 🌟 Overview
**CricBid** is a premium, real-time web application that allows you and your friends to host and participate in live fantasy cricket auctions. Featuring a stunning glassmorphism UI, real-time synchronized bidding, WebRTC-based video chat, and advanced AI integration, CricBid provides the ultimate, immersive auction experience right in your browser.

## 🚀 Live Demo
**[Click Here to Play CricBid!](https://anirudhrao-24.github.io/CricBid/)**  

---

## ✨ Key Features

### 🔨 Live Real-Time Bidding
- **Synchronized Timers:** Accurate countdown timers synced across all connected clients to ensure fair play.
- **Dynamic Bidding Controls:** Increment your bids effortlessly with dedicated buttons.
- **Budget Tracking:** Automated purse management prevents over-bidding. Teams start with a fixed purse (e.g., ₹120.0 Cr) that updates dynamically.

### 👥 Room Management & Authentication
- **Secure Authentication:** Log in seamlessly using Google Authentication or jump straight into the action via Guest Mode.
- **Host Controls:** Create custom rooms, choose the auction format (T20, ODI, Test, Legends), and manage the flow. The host can start the next bid, pause the auction, mark players unsold, or skip.
- **Invite System:** Share your 6-character room code or invite online players directly from the global lobby.

### 🎙️ Integrated Voice & Video Chat (WebRTC)
- **Built-in Comms:** No need for third-party apps like Discord or Zoom. CricBid features a built-in, low-latency video and audio gallery.
- **Toggle Controls:** Easily mute your mic or turn off your camera during the heat of the auction.

### 🤖 Advanced AI Integration (Powered by Gemini)
- **AI Strategist / Coach:** Access real-time advice during the auction. The AI analyzes your current drafted squad and the remaining player pool, and recommends 3 specific players to target to balance your team's weaknesses.
- **AI Analytics & Stats:** View detailed insights for each player, including an AI Rating out of 10, Predicted Value vs. Live Bid tracking, Career Stats, and Recent Form.
- **Post-Auction Tournament Preview:** Once the auction concludes, the AI evaluates all finalized squads to predict the Tournament Champion and curates a "Tournament Best XI" based on all drafted players.

### 📋 Post-Auction Draft
- **Squad Completion:** Did a franchise fail to secure enough players? The host can allocate unsold players in the Post-Auction Draft to complete squads.

### 🎨 Premium UI/UX
- **Modern Aesthetics:** Dark-themed, glassmorphism design with vibrant glowing accents.
- **Responsive Layout:** fully optimized for desktops, tablets, and mobile devices with touch-scroll support.
- **Celebratory Effects:** Canvas-confetti triggers for major milestones or when star players are sold.

---

## 🛠️ Tech Stack & Architecture

CricBid is built entirely with modern web technologies, prioritizing speed, real-time synchronization, and aesthetic excellence.

**Frontend:**
- **HTML5 & CSS3:** Semantic markup and layout structure.
- **JavaScript (Vanilla ES6):** Core application logic, DOM manipulation, and state management.
- **Tailwind CSS:** Utility-first CSS framework (via CDN) for rapid UI styling, custom animations, and responsive breakpoints.
- **Google Fonts:** Utilizing *Outfit* and *Space Grotesk* for sleek, modern typography.

**Backend & Real-Time Sync:**
- **Firebase Firestore:** NoSQL cloud database used to store room states, player datasets, global presence, live bids, and chat messages in real time.
- **Firebase Authentication:** Handles secure user sign-ins via Google and Anonymous (Guest) providers.

**Networking & Communications:**
- **PeerJS (WebRTC):** Powers the peer-to-peer real-time video and audio streams between auction participants.

**Artificial Intelligence:**
- **Google Gemini API:** Generates dynamic text responses for the AI Coach, squad analysis, and post-auction predictions.

---

## 📖 How to Play
1. **Login:** Choose "Continue with Google" or "Play as Guest".
2. **Lobby:** Click "Host New Auction" to create a room, or enter a Room Code to join a friend's auction.
3. **The Auction Room:** Wait for the host to start. When a player appears on the block, use the bidding controls to place your bid before the timer runs out.
4. **Strategize:** Open the AI Coach for live recommendations or click "Analytics" on the player card for deep stats.
5. **Win:** Build the ultimate squad, and see if the AI predicts your team as the Champion in the Tournament Preview!

---

## 📄 License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
