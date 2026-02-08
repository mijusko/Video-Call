const wsProtocol = window.location.protocol === "https:" ? "wss://" : "ws://";
const socket = new WebSocket(wsProtocol + window.location.host + "/signal");
const configuration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun2.l.google.com:19302" },
        { urls: "stun:stun3.l.google.com:19302" },
        { urls: "stun:stun4.l.google.com:19302" },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

let username;
let roomId;
let localStream;
let screenStream;
let peers = {}; // userId -> RTCPeerConnection
let iceCandidateQueue = {}; // userId -> [candidates]

// UI Elements
const welcomeScreen = document.getElementById('welcome-screen');
const lobbyScreen = document.getElementById('lobby-screen');
const roomScreen = document.getElementById('room-screen');
const usernameInput = document.getElementById('username-input');
const getStartedBtn = document.getElementById('get-started-btn');
const displayName = document.getElementById('display-name');
const roomInput = document.getElementById('room-input');
const joinRoomBtn = document.getElementById('join-room-btn');
const videoGrid = document.getElementById('video-grid');
const localVideoContainer = document.getElementById('local-video-container'); // NEW
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendMsgBtn = document.getElementById('send-msg-btn');
const micBtn = document.getElementById('mic-btn');
const cameraBtn = document.getElementById('camera-btn');
const screenBtn = document.getElementById('screen-btn');
const leaveBtn = document.getElementById('leave-btn');

// --- Navigation ---
getStartedBtn.onclick = () => {
    if (usernameInput.value.trim()) {
        username = usernameInput.value.trim();
        displayName.innerText = username;
        welcomeScreen.classList.remove('active');
        lobbyScreen.classList.add('active');
        
        sendSignal({ type: "login", username: username });
    }
};
 
joinRoomBtn.onclick = async () => {
    if (roomInput.value.trim()) {
        roomId = roomInput.value.trim();
        lobbyScreen.classList.remove('active');
        roomScreen.classList.add('active');
        
        await startLocalVideo();
        sendSignal({ type: "join_room", roomId: roomId });
    }
};

leaveBtn.onclick = () => {
    location.reload(); // Simple way to leave and reset
};

// --- WebSocket Signaling ---
socket.onmessage = async (event) => {
    const data = JSON.parse(event.data);
    console.log("Received signal:", data.type, data);
    
    switch (data.type) {
        case "existing_users":
            data.users.forEach(user => {
                createPeerConnection(user.userId, false, user.username);
            });
            break;
            
        case "user_joined":
            createPeerConnection(data.userId, true, data.username);
            addMessage("System", `${data.username} joined the room.`);
            break;
            
        case "offer":
            await handleOffer(data);
            break;
            
        case "answer":
            await handleAnswer(data);
            break;
            
        case "candidate":
            await handleCandidate(data);
            break;
            
        case "user_left":
            removePeer(data.userId);
            addMessage("System", `${data.username} left the room.`);
            break;
            
        case "chat":
            addMessage(data.senderName, data.content);
            break;
    }
};

function sendSignal(data) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}

// --- WebRTC Logic ---

async function startLocalVideo() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        addVideoElement('local', localStream, true);
    } catch (err) {
        console.error("Error accessing media devices.", err);
        alert("Could not access camera/microphone.");
    }
}

function createPeerConnection(targetId, initiator, targetUsername) {
    if (peers[targetId]) return peers[targetId];

    console.log("Creating peer connection for", targetId, "initiator:", initiator);
    const pc = new RTCPeerConnection(configuration);
    peers[targetId] = pc;
    iceCandidateQueue[targetId] = [];
    
    // Add local tracks to peer connection
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    } else {
        console.warn("No local stream available when creating peer connection");
    }
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal({
                type: "candidate",
                target: targetId,
                candidate: event.candidate
            });
        }
    };
    
    pc.ontrack = (event) => {
        console.log("Received remote track from", targetId, "kind:", event.track.kind);
        const stream = event.streams[0];
        if (!stream) {
            console.warn("Received track without stream", event.track);
            return;
        }
        if (!document.getElementById(`video-${targetId}`)) {
            addVideoElement(targetId, stream, false, targetUsername);
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE Connection State with ${targetId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
             console.warn(`ICE connection with ${targetId} failed/disconnected`);
             // Optional: Attempt restart or cleanup
        }
    };

    pc.onnegotiationneeded = () => {
         console.log(`Negotiation needed for ${targetId}`);
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${targetId}: ${pc.connectionState}`);
    };
    
    if (initiator) {
        pc.createOffer().then(offer => {
            pc.setLocalDescription(offer);
            sendSignal({
                type: "offer",
                target: targetId,
                sdp: offer
            });
        });
    }
    
    return pc;
}

async function handleOffer(data) {
    let pc = peers[data.sender];
    if (!pc) {
        pc = createPeerConnection(data.sender, false); 
    } else {
        console.log("Existing peer connection found for offer from", data.sender);
    }
    
    if (pc.signalingState !== "stable" && pc.signalingState !== "have-local-offer") {
         // This might happen in glare situations or if we are already processing
         console.warn(`Signaling state is ${pc.signalingState} when receiving offer from ${data.sender}. Proceeding anyway.`);
    }

    console.log("Setting remote description (offer) from", data.sender);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    
    // Process queued candidates
    if (iceCandidateQueue[data.sender] && iceCandidateQueue[data.sender].length > 0) {
        console.log(`Processing ${iceCandidateQueue[data.sender].length} queued candidates for ${data.sender}`);
        for (let candidate of iceCandidateQueue[data.sender]) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        iceCandidateQueue[data.sender] = [];
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({
        type: "answer",
        target: data.sender,
        sdp: answer
    });
}

async function handleAnswer(data) {
    const pc = peers[data.sender];
    if (pc) {
        console.log("Setting remote description (answer) from", data.sender);
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
}

async function handleCandidate(data) {
    const pc = peers[data.sender];
    if (pc) {
        if (pc.remoteDescription) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                console.log("Added ICE candidate from", data.sender);
            } catch (e) {
                console.error("Error adding ice candidate", e);
            }
        } else {
            console.log("Queueing ICE candidate from", data.sender);
            if (!iceCandidateQueue[data.sender]) {
                iceCandidateQueue[data.sender] = [];
            }
            iceCandidateQueue[data.sender].push(data.candidate);
        }
    } else {
         // This can happen if candidate arrives before offer/peer creation
         // We might need to store it temporarily if we knew who it was for, but usually 'offer' triggers peer creation first.
         // In this simplified flow, we assume offer comes first or creates peer.
         // If we strictly want to support candidate-first, we'd need a global queue.
         console.warn("Received candidate for unknown peer", data.sender);
    }
}

function removePeer(userId) {
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }
    delete iceCandidateQueue[userId];
    
    const videoWrapper = document.getElementById(`wrapper-${userId}`);
    if (videoWrapper) videoWrapper.remove();
}

// --- UI Helpers ---

function addVideoElement(id, stream, isLocal, name) {
    // Prevent duplicates
    if (document.getElementById(`wrapper-${id}`)) return;

    const wrapper = document.createElement('div');
    wrapper.className = isLocal ? 'local-video-wrapper' : 'video-wrapper';
    wrapper.id = `wrapper-${id}`;
    
    const video = document.createElement('video');
    video.id = `video-${id}`;
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    
    if (isLocal) {
        video.muted = true; 
        video.style.transform = "rotateY(180deg)";
        wrapper.appendChild(video);
        localVideoContainer.innerHTML = ''; // Clear previous if any
        localVideoContainer.appendChild(wrapper);
    } else {
        wrapper.appendChild(video);
        
        // Name tag
        const label = document.createElement('div');
        label.innerText = name || "Unknown";
        label.style.position = 'absolute';
        label.style.bottom = '10px';
        label.style.left = '10px';
        label.style.color = 'white';
        label.style.backgroundColor = 'rgba(0,0,0,0.5)';
        label.style.padding = '2px 8px';
        label.style.borderRadius = '4px';
        label.style.fontSize = '12px';
        wrapper.appendChild(label);
        
        videoGrid.appendChild(wrapper);
    }
}

// --- Chat ---
sendMsgBtn.onclick = sendChat;
chatInput.onkeypress = (e) => {
    if (e.key === 'Enter') sendChat();
};

function sendChat() {
    const text = chatInput.value.trim();
    if (text) {
        // Send to server
        sendSignal({ type: "chat", content: text });
        chatInput.value = '';
    }
}

function addMessage(sender, text) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';
    if (sender === username) {
        msgDiv.classList.add('self');
    }
    
    msgDiv.innerHTML = `<strong>${sender}</strong>${text}`;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// --- Controls ---
let isAudioEnabled = true;
let isVideoEnabled = true;
let isScreenSharing = false;

micBtn.onclick = () => {
    isAudioEnabled = !isAudioEnabled;
    localStream.getAudioTracks()[0].enabled = isAudioEnabled;
    micBtn.innerHTML = isAudioEnabled ? '<i class="fa-solid fa-microphone"></i>' : '<i class="fa-solid fa-microphone-slash"></i>';
    micBtn.classList.toggle('muted', !isAudioEnabled);
};

cameraBtn.onclick = () => {
    isVideoEnabled = !isVideoEnabled;
    localStream.getVideoTracks()[0].enabled = isVideoEnabled;
    cameraBtn.innerHTML = isVideoEnabled ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>';
    cameraBtn.classList.toggle('muted', !isVideoEnabled);
};

screenBtn.onclick = async () => {
    if (!isScreenSharing) {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Replace track in all peer connections
            for (let id in peers) {
                const sender = peers[id].getSenders().find(s => s.track.kind === 'video');
                if (sender) sender.replaceTrack(screenTrack);
            }
            
            // Update local video view
            const localVideo = document.getElementById('video-local');
            if (localVideo) {
                localVideo.srcObject = screenStream;
                localVideo.style.transform = "none"; // Don't mirror screen share
            }
            
            screenTrack.onended = () => {
                stopScreenShare();
            };
            
            isScreenSharing = true;
            screenBtn.classList.add('active');
        } catch (err) {
            console.error("Error sharing screen", err);
            if (err.name === 'NotSupportedError') {
                alert("Screen sharing is not supported in this browser/view. Please try opening the app in an external browser (Chrome, Edge, Firefox).");
            } else if (err.name !== 'NotAllowedError') { // Ignore if user cancelled
                alert("Failed to share screen: " + err.message);
            }
        }
    } else {
        stopScreenShare();
    }
};

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
    }
    
    const videoTrack = localStream.getVideoTracks()[0];
    
    // Replace back to camera
    for (let id in peers) {
        const sender = peers[id].getSenders().find(s => s.track.kind === 'video');
        if (sender) sender.replaceTrack(videoTrack);
    }
    
    const localVideo = document.getElementById('video-local');
    if (localVideo) {
        localVideo.srcObject = localStream;
        localVideo.style.transform = "rotateY(180deg)";
    }
    
    isScreenSharing = false;
    screenBtn.classList.remove('active');
}
