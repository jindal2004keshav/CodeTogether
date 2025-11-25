import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  createDevice,
  loadDevice,
  createSendTransport,
  createRecvTransport,
  consumeStream,
} from '../utils/mediasoup-client';

const SCREEN_SHARE_ENCODINGS = [
  { rid: 'r0', maxBitrate: 100000, scalabilityMode: 'S1T3' },
  { rid: 'r1', maxBitrate: 300000, scalabilityMode: 'S1T3' },
  { rid: 'r2', maxBitrate: 900000, scalabilityMode: 'S1T3' },
];

export const useMediasoup = (socket, roomId, name, action) => {
  // Local Media State
  const [myStream, setMyStream] = useState(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(false);
  const [isVideoEnabled, setIsVideoEnabled] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenStream, setScreenStream] = useState(null);
  const [isHandRaised, setIsHandRaised] = useState(false);

  // Remote Media State
  const [remoteStreams, setRemoteStreams] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [socketId, setSocketId] = useState(null);
  const navigate = useNavigate();

  // Mediasoup-specific refs
  const deviceRef = useRef(null);
  const sendTransportRef = useRef(null);
  const recvTransportRef = useRef(null);
  const producersRef = useRef({ video: null, audio: null, screen: null });
  const consumersRef = useRef(new Map());
  const screenStreamRef = useRef(null);

  const handleConsumeStream = useCallback(async (producerId, socketId, kind, type) => {
    if (!deviceRef.current || !recvTransportRef.current?.id) return;
    
    try {
      const { consumer, stream } = await consumeStream(socket, deviceRef.current, recvTransportRef.current, producerId, deviceRef.current.rtpCapabilities);
      // consumersRef.current.set(consumer.id, consumer);

      consumersRef.current.set(consumer.id, {
        consumer,
        socketId,
        kind,
        type,
      });

      consumer.on("producerclose", () => {
        consumersRef.current.delete(consumer.id);
        setRemoteStreams(prev => {
          const newStreams = { ...prev };
          if (newStreams[socketId]) {
            const streamType = type === 'screen' ? 'screen' : kind;
            delete newStreams[socketId][streamType];
            if (Object.keys(newStreams[socketId]).length === 0) delete newStreams[socketId];
          }
          return newStreams;
        });
      });

      const streamType = type === 'screen' ? 'screen' : kind;
      setRemoteStreams(prev => ({
        ...prev,
        [socketId]: { ...prev[socketId], [streamType]: stream },
      }));

    } catch (error) {
      console.error(`Error consuming stream of type ${type} from ${socketId}:`, error);
    }
  }, [socket]);

  const handleIncomingMessage = useCallback((message) => {
    if (!message) return;
    setChatMessages(prev => [...prev, message]);
  }, []);

  useEffect(() => {
    if (!socket) {
      setSocketId(null);
      return;
    }
    const updateSocketId = () => setSocketId(socket.id);
    const handleDisconnect = () => setSocketId(null);
    if (socket.id) {
      setSocketId(socket.id);
    }
    socket.on('connect', updateSocketId);
    socket.on('reconnect', updateSocketId);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off('connect', updateSocketId);
      socket.off('reconnect', updateSocketId);
      socket.off('disconnect', handleDisconnect);
    };
  }, [socket]);

  const syncHandRaiseState = useCallback((userList) => {
    if (!Array.isArray(userList)) {
      return;
    }
    let myStatus = false;
    userList.forEach(({ id, handRaised }) => {
      if (id === socketId) {
        myStatus = !!handRaised;
      }
    });
    setIsHandRaised(myStatus);
  }, [socketId]);

  const handRaiseStatus = useMemo(() => {
    return users.reduce((acc, user) => {
      acc[user.id] = !!user.handRaised;
      return acc;
    }, {});
  }, [users]);

  useEffect(() => {
    if (roomId === "solo" || !socket || !socketId || !name || !action) return;

    let isMounted = true;

    const initMediasoup = async () => {
      try {
        const device = createDevice();
        deviceRef.current = device;

        const routerRtpCapabilities = await new Promise(resolve => socket.emit("get-router-rtp-capabilities", roomId, resolve));
        await loadDevice(routerRtpCapabilities, device);

        sendTransportRef.current = await createSendTransport(socket, device, roomId);
        recvTransportRef.current = await createRecvTransport(socket, device, roomId);

        socket.emit("get-initial-producers", roomId, producers => {
          if (!isMounted) return;
          for (const { producerId, socketId, kind, type } of producers) {
            handleConsumeStream(producerId, socketId, kind, type);
          }
        });
      } catch (err) {
        console.error("Initialization failed:", err);
        toast.error("Media connection failed.");
      }
    };

    const handleNewProducer = ({ producerId, socketId, kind, type }) => handleConsumeStream(producerId, socketId, kind, type);
    const handleProducerClosed = ({ socketId }) => setRemoteStreams(prev => { const ns = { ...prev }; delete ns[socketId]; return ns; });
    const handleSpecificProducerClosed = ({ producerId }) => {
      for (const consumer of consumersRef.current.values()) {
        if (consumer.producerId === producerId) {
          consumer.close();
          break;
        }
      }

      let consumerInfoToDelete = null;
      // Find the consumer's info object using the producerId
      for (const [consumerId, consumerInfo] of consumersRef.current.entries()) {
        if (consumerInfo.consumer.producerId === producerId) {
          consumerInfoToDelete = { consumerId, ...consumerInfo };
          break;
        }
      }
      if (!consumerInfoToDelete) {
        return;
      }
      const { consumerId, consumer, socketId, kind, type } = consumerInfoToDelete;

      consumer.close();
      consumersRef.current.delete(consumerId);

      setRemoteStreams(prev => {
        const newStreams = { ...prev };
        if (newStreams[socketId]) {
          const streamType = type === 'screen' ? 'screen' : kind;          
          delete newStreams[socketId][streamType];
          
          if (Object.keys(newStreams[socketId]).length === 0) {
            delete newStreams[socketId];
          }
        }
        return newStreams;
      });
    };

    const handleUserListUpdate = userList => {
      syncHandRaiseState(userList);
      setUsers(userList.filter(u => u.id !== socketId));
    };
    const handleNewUser = ({ name }) => {
      toast(`${name} joined the room.`);
    };
    const handleUserLeft = ({ name }) => {
      toast(`${name} left the room.`);
    };
    const handleHandRaiseUpdate = ({ userId, handRaised }) => {
      if (!userId) return;
      if (userId === socketId) {
        setIsHandRaised(!!handRaised);
        return;
      }
      setUsers(prev =>
        prev.map(user =>
          user.id === userId ? { ...user, handRaised: !!handRaised } : user
        )
      );
    };

    const handleWindowVisibilityChange = ({ userId, name, isHidden }) => {
      if (!userId || userId === socketId) return;
      const userName = name || "Someone";
      if (isHidden) {
        toast(`${userName} switched to another window`, { icon: '👋' });
      } else {
        toast(`${userName} returned to the meeting`, { icon: '👀' });
      }
    };
    
    socket.on("new-producer", handleNewProducer);
    socket.on("producer-closed", handleProducerClosed);
    socket.on("specific-producer-closed", handleSpecificProducerClosed);
    socket.on("update-user-list", handleUserListUpdate);
    socket.on("user-joined", handleNewUser);
    socket.on("user-left", handleUserLeft);
    socket.on("hand-raise-update", handleHandRaiseUpdate);
    socket.on("chat-message", handleIncomingMessage);
    socket.on("window-visibility-change", handleWindowVisibilityChange);

    const eventToEmit = action === 'create' ? 'create-room' : 'join-room';
    
    socket.emit(eventToEmit, roomId, name, (response) => {
      if (!isMounted) return;

      if (response.success) {
        toast.success(response.message);
        setUsers(response.users.filter(u => u.id !== socketId));
        setChatMessages(response.messages || []);
        initMediasoup();
      } else {
        toast.error(response.message);
        navigate('/');
      }
    });
    
    return () => {
      isMounted = false;
      myStream?.getTracks().forEach(track => track.stop());
      screenStreamRef.current?.getTracks().forEach(track => track.stop());
      sendTransportRef.current?.close();
      recvTransportRef.current?.close();

      socket.off("new-producer", handleNewProducer);
      socket.off("producer-closed", handleProducerClosed);
      socket.off("specific-producer-closed", handleSpecificProducerClosed);
      socket.off("update-user-list", handleUserListUpdate);
      socket.off("user-joined", handleNewUser);
      socket.off("user-left", handleUserLeft);
      socket.off("hand-raise-update", handleHandRaiseUpdate);
      socket.off("chat-message", handleIncomingMessage);
      socket.off("window-visibility-change", handleWindowVisibilityChange);
      if (roomId !== "solo") socket.emit("leave-room");
    };
  }, [socket, socketId, roomId, name, action, handleConsumeStream, navigate, syncHandRaiseState, handleIncomingMessage]);

  const toggleHandRaise = useCallback(() => {
    if (!socket || !socketId || roomId === "solo") return;
    const nextState = !isHandRaised;
    setIsHandRaised(nextState);
    socket.emit("toggle-hand-raise", { handRaised: nextState }, (response) => {
      if (!response?.success) {
        setIsHandRaised(!nextState);
        toast.error(response?.message || "Unable to update hand raise");
      }
    });
  }, [socket, socketId, roomId, isHandRaised]);

  const toggleScreenShare = useCallback(async () => {
    if (!sendTransportRef.current) return toast.error("Media server not connected.");

    if (isScreenSharing) {
      socket.emit('close-producer', { producerId: producersRef.current.screen.id });
      producersRef.current.screen?.close();
      producersRef.current.screen = null;
      screenStreamRef.current?.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
      setScreenStream(null);
      setIsScreenSharing(false);
      toast.success("Screen sharing stopped");
    } else {
      try {
        const captureStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = captureStream.getVideoTracks()[0];
        if (!screenTrack) throw new Error("No video track found");

        screenTrack.addEventListener('ended', () => {
          producersRef.current.screen?.close();
          producersRef.current.screen = null;
          setScreenStream(null);
          setIsScreenSharing(false);
          toast("Screen sharing ended");
        });

        screenStreamRef.current = captureStream;
        setScreenStream(captureStream);
        const screenProducer = await sendTransportRef.current.produce({ track: screenTrack, encodings: SCREEN_SHARE_ENCODINGS, appData: { type: 'screen' } });
        producersRef.current.screen = screenProducer;
        setIsScreenSharing(true);
        toast.success("Screen sharing started");
      } catch (error) {
        if (error.name !== 'NotAllowedError') toast.error("Could not start screen sharing");
        setIsScreenSharing(false);
        setScreenStream(null);
      }
    }
  }, [isScreenSharing]);

  const toggleMedia = useCallback(async (mediaType) => {
    if (!sendTransportRef.current) {
        toast.error("Media connection is not yet available.");
        return;
    }

    const producer = producersRef.current[mediaType];
    const isEnabling = !producer;

    if (isEnabling) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ [mediaType]: true });
        const track = stream.getTracks()[0];

        // Check transport connection state before producing
        const connectionState = sendTransportRef.current.connectionState;
        if (connectionState === 'failed' || connectionState === 'disconnected') {
          toast.error("Media transport is not connected. Please refresh the page.");
          track.stop();
          return;
        }
        const newProducer = await sendTransportRef.current.produce({
          track,
          appData: { type: mediaType },
        });

        producersRef.current[mediaType] = newProducer;
            
        setMyStream(prevStream => {
          const newStream = prevStream ? new MediaStream(prevStream.getTracks()) : new MediaStream();
          newStream.addTrack(track);
          return newStream;
        });
        if (mediaType === 'video') setIsVideoEnabled(true);
        if (mediaType === 'audio') setIsAudioEnabled(true);
      } catch (error) {
        console.error(`Failed to get ${mediaType} device.`, error);
        if (error.message && (error.message.includes('recv parameters') || error.message.includes('ERROR_CONTENT'))) {
          toast.error(`Codec negotiation failed. The room may need to be recreated. Please leave and rejoin the room.`, { duration: 5000 });
        } else if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
          toast.error(`Permission denied for ${mediaType}. Please allow access in your browser settings.`);
        } else {
          toast.error(`Could not start ${mediaType}. ${error.message || 'Check permissions.'}`);
        }
      }
    } else {
      socket.emit('close-producer', { producerId: producer.id });
      producer.close();
      producersRef.current[mediaType] = null;
      
      setMyStream(prevStream => {
        if (!prevStream) return null;
        const trackToRemove = prevStream.getTracks().find(t => t.kind === mediaType);
        if (trackToRemove) {
            trackToRemove.stop();
            prevStream.removeTrack(trackToRemove);
        }
        if (prevStream.getTracks().length === 0) {
          return null; 
        }
        return new MediaStream(prevStream.getTracks());
      });
      if (mediaType === 'video') setIsVideoEnabled(false);
      if (mediaType === 'audio') setIsAudioEnabled(false);
    }
  }, []);

  const sendChatMessage = useCallback((message) => {
    if (!socket || !socketId || roomId === "solo") return;
    const trimmed = typeof message === "string" ? message.trim() : "";
    if (!trimmed) return;

    socket.emit("chat-send-message", { message: trimmed }, (response) => {
      if (response?.success) return;
      toast.error(response?.message || "Unable to send message");
    });
  }, [socket, socketId, roomId]);

  return {
    myStream,
    screenStream,
    remoteStreams,
    users,
    handRaiseStatus,
    isHandRaised,
    isAudioEnabled,
    isVideoEnabled,
    isScreenSharing,
    toggleMedia,
    toggleScreenShare,
    toggleHandRaise,
    chatMessages,
    sendChatMessage,
    socketId,
  };
};