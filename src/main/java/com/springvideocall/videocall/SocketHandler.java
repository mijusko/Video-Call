package com.springvideocall.videocall;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class SocketHandler extends TextWebSocketHandler {

    // Session ID -> WebSocketSession
    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    // Session ID -> Username
    private final Map<String, String> userNames = new ConcurrentHashMap<>();
    // Session ID -> Room ID
    private final Map<String, String> roomMap = new ConcurrentHashMap<>();

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        sessions.put(session.getId(), session);
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        String sessionId = session.getId();
        String roomId = roomMap.get(sessionId);
        String username = userNames.get(sessionId);
        
        sessions.remove(sessionId);
        userNames.remove(sessionId);
        roomMap.remove(sessionId);

        if (roomId != null) {
            broadcastToRoom(roomId, Map.of(
                "type", "user_left",
                "userId", sessionId,
                "username", username != null ? username : "Unknown"
            ));
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        try {
            Map<String, Object> payload = objectMapper.readValue(message.getPayload(), Map.class);
            String type = (String) payload.get("type");

            if ("login".equals(type)) {
                String username = (String) payload.get("username");
                userNames.put(session.getId(), username);
                // Ack login if needed, or just proceed
            } else if ("join_room".equals(type)) {
                String roomId = (String) payload.get("roomId");
                roomMap.put(session.getId(), roomId);
                
                // 1. Notify others in the room
                broadcastToRoom(roomId, Map.of(
                    "type", "user_joined",
                    "userId", session.getId(),
                    "username", userNames.getOrDefault(session.getId(), "Anonymous")
                ), session.getId()); // Exclude sender

                // 2. Send list of existing users to the new user
                List<Map<String, String>> existingUsers = new ArrayList<>();
                for (Map.Entry<String, String> entry : roomMap.entrySet()) {
                    if (entry.getValue().equals(roomId) && !entry.getKey().equals(session.getId())) {
                        existingUsers.add(Map.of(
                            "userId", entry.getKey(),
                            "username", userNames.getOrDefault(entry.getKey(), "Unknown")
                        ));
                    }
                }
                
                sendToSession(session, Map.of(
                    "type", "existing_users",
                    "users", existingUsers
                ));

            } else if ("offer".equals(type) || "answer".equals(type) || "candidate".equals(type)) {
                String targetId = (String) payload.get("target");
                WebSocketSession targetSession = sessions.get(targetId);
                if (targetSession != null && targetSession.isOpen()) {
                    // Add sender ID to payload so receiver knows who it's from
                    payload.put("sender", session.getId());
                    sendToSession(targetSession, payload);
                }
            } else if ("chat".equals(type)) {
                String roomId = roomMap.get(session.getId());
                if (roomId != null) {
                    payload.put("senderId", session.getId());
                    payload.put("senderName", userNames.get(session.getId()));
                    broadcastToRoom(roomId, payload, null); // Broadcast to everyone including self (to simplify UI)
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void broadcastToRoom(String roomId, Map<String, Object> message) throws IOException {
        broadcastToRoom(roomId, message, null);
    }

    private void broadcastToRoom(String roomId, Map<String, Object> message, String excludeSessionId) throws IOException {
        String json = objectMapper.writeValueAsString(message);
        for (Map.Entry<String, String> entry : roomMap.entrySet()) {
            if (entry.getValue().equals(roomId)) {
                if (excludeSessionId != null && entry.getKey().equals(excludeSessionId)) {
                    continue;
                }
                WebSocketSession s = sessions.get(entry.getKey());
                if (s != null && s.isOpen()) {
                    synchronized (s) {
                        s.sendMessage(new TextMessage(json));
                    }
                }
            }
        }
    }

    private void sendToSession(WebSocketSession session, Map<String, Object> message) throws IOException {
        if (session.isOpen()) {
            synchronized (session) {
                session.sendMessage(new TextMessage(objectMapper.writeValueAsString(message)));
            }
        }
    }
}
