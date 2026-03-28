import { RedisClient } from '@shared/components/redis-pubsub/redis';
import Logger from '@shared/utils/logger';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { Server, Socket } from 'socket.io';

export class SocketService {
  private static instance: SocketService;
  private io!: Server;
  private userSockets: Map<string, string> = new Map();

  private constructor() {}

  public static getInstance(): SocketService {
    if (!SocketService.instance) {
      SocketService.instance = new SocketService();
    }
    return SocketService.instance;
  }

  public init(server: HttpServer) {
    this.io = new Server(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    this.io.use(this.authMiddleware);
    this.io.on('connection', (socket: Socket) => {
      this.handleConnection(socket);
    });

    void this.subscribeToRedisEvents();
    Logger.success('Socket.io initialized');
  }

  private authMiddleware = (socket: Socket, next: (err?: Error) => void) => {
    const token =
      socket.handshake.auth.token ||
      socket.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      next(new Error('Authentication error'));
      return;
    }

    try {
      const decoded = jwt.decode(token) as { sub?: string } | null;
      if (!decoded?.sub) {
        next(new Error('Invalid token'));
        return;
      }

      socket.data.userId = decoded.sub;
      next();
    } catch {
      next(new Error('Authentication error'));
    }
  };

  private handleConnection(socket: Socket) {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    this.userSockets.set(userId, socket.id);
    Logger.info(`User connected: ${userId}`);

    socket.on('disconnect', () => {
      this.userSockets.delete(userId);
      Logger.info(`User disconnected: ${userId}`);
    });

    socket.on(
      'call_user',
      (data: { userToCall: string; signalData: unknown; from: string; name: string }) => {
        const targetSocket = this.userSockets.get(data.userToCall);
        if (!targetSocket) return;

        this.io.to(targetSocket).emit('call_user', {
          signal: data.signalData,
          from: data.from,
          name: data.name
        });
      }
    );

    socket.on('answer_call', (data: { to: string; signal: unknown }) => {
      const targetSocket = this.userSockets.get(data.to);
      if (!targetSocket) return;

      this.io.to(targetSocket).emit('call_accepted', data.signal);
    });

    socket.on('end_call', (data: { to: string }) => {
      const targetSocket = this.userSockets.get(data.to);
      if (!targetSocket) return;

      this.io.to(targetSocket).emit('call_ended');
    });
  }

  private async subscribeToRedisEvents() {
    const redis = RedisClient.getInstance();

    await redis.subscribe('NEW_MESSAGE', (message: string) => {
      try {
        const parsed = JSON.parse(message) as { payload?: { receiverId?: string; message?: unknown } };
        const receiverId = parsed.payload?.receiverId;
        const payloadMessage = parsed.payload?.message;

        if (!receiverId || !payloadMessage) return;

        const targetSocket = this.userSockets.get(receiverId);
        if (targetSocket) {
          this.io.to(targetSocket).emit('new_message', payloadMessage);
        }
      } catch (error) {
        Logger.error(`Error parsing Redis message: ${error}`);
      }
    });

    await redis.subscribe('MESSAGE_REACTION', (message: string) => {
      try {
        const parsed = JSON.parse(message) as { payload?: Record<string, unknown> & { receiverId?: string } };
        const payload = parsed.payload;
        if (!payload) return;

        const receiverId = payload.receiverId;
        if (!receiverId) return;

        const targetSocket = this.userSockets.get(receiverId);
        if (!targetSocket) return;

        const { receiverId: _ignored, ...data } = payload;
        this.io.to(targetSocket).emit('message_reaction', data);
      } catch (error) {
        Logger.error(`Error parsing Redis message: ${error}`);
      }
    });
  }
}
