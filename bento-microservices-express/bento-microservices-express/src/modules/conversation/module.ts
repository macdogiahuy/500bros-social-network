import { upload } from '@shared/services/file-upload.service';
import { AppEvent } from '@shared/model/event';
import { ServiceContext } from '@shared/interface';
import crypto from 'crypto';
import { Router } from 'express';
import prisma from '@shared/components/prisma';
import { RedisClient } from '@shared/components/redis-pubsub/redis';

function buildConversationRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    try {
      const userId = res.locals.requester?.sub as string | undefined;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const conversations = await prisma.conversation.findMany({
        where: {
          OR: [
            { senderId: userId },
            { receiverId: userId },
            { participants: { some: { userId } } }
          ]
        },
        include: {
          sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          receiver: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          participants: {
            include: {
              user: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } }
            }
          },
          messages: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            include: {
              sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } }
            }
          }
        },
        orderBy: { updatedAt: 'desc' }
      });

      res.status(200).json({ data: conversations });
    } catch (error) {
      console.error('Error getting conversations:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/initiate', async (req, res) => {
    try {
      const { receiverId, userIds, name } = req.body as {
        receiverId?: string;
        userIds?: string[];
        name?: string;
      };
      const senderId = res.locals.requester?.sub as string | undefined;

      if (!senderId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (userIds && Array.isArray(userIds) && userIds.length > 0) {
        const conversation = await prisma.conversation.create({
          data: {
            id: crypto.randomUUID(),
            type: 'GROUP',
            name: name || 'New Group',
            participants: {
              create: [{ userId: senderId }, ...userIds.map((id) => ({ userId: id }))]
            }
          },
          include: {
            participants: {
              include: {
                user: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } }
              }
            }
          }
        });

        res.status(201).json({ data: conversation });
        return;
      }

      if (!receiverId) {
        res.status(400).json({ error: 'Receiver ID is required' });
        return;
      }

      const existingConversation = await prisma.conversation.findFirst({
        where: {
          OR: [
            { AND: [{ senderId }, { receiverId }] },
            { AND: [{ senderId: receiverId }, { receiverId: senderId }] }
          ]
        },
        include: {
          sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          receiver: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          messages: {
            take: 20,
            orderBy: { createdAt: 'desc' },
            include: {
              sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } }
            }
          }
        }
      });

      if (existingConversation) {
        res.status(200).json({ data: existingConversation });
        return;
      }

      const conversation = await prisma.conversation.create({
        data: {
          id: crypto.randomUUID(),
          type: 'DIRECT',
          sender: { connect: { id: senderId } },
          receiver: { connect: { id: receiverId } },
          participants: {
            create: [{ userId: senderId }, { userId: receiverId }]
          }
        },
        include: {
          sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          receiver: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          participants: {
            include: {
              user: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } }
            }
          }
        }
      });

      res.status(201).json({ data: conversation });
    } catch (error) {
      console.error('Error initiating conversation:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/:conversationId/messages', async (req, res) => {
    try {
      const userId = res.locals.requester?.sub as string | undefined;
      const { conversationId } = req.params;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          OR: [
            { senderId: userId },
            { receiverId: userId },
            { participants: { some: { userId } } }
          ]
        }
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const messages = await prisma.message.findMany({
        where: { conversationId },
        include: {
          sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
          reactions: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, avatar: true } }
            }
          }
        },
        orderBy: { createdAt: 'asc' }
      });

      res.status(200).json({ data: messages });
    } catch (error) {
      console.error('Error getting messages:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/:conversationId/messages', upload.single('file'), async (req, res) => {
    try {
      const userId = res.locals.requester?.sub as string | undefined;
      const { conversationId } = req.params;
      const { content } = req.body as { content?: string };
      const file = req.file;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (!content?.trim() && !file) {
        res.status(400).json({ error: 'Message content or file is required' });
        return;
      }

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          OR: [
            { senderId: userId },
            { receiverId: userId },
            { participants: { some: { userId } } }
          ]
        },
        include: {
          participants: true
        }
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      const message = await prisma.message.create({
        data: {
          id: crypto.randomUUID(),
          content: content?.trim(),
          conversation: { connect: { id: conversationId } },
          sender: { connect: { id: userId } },
          ...(file
            ? {
                fileUrl: `/uploads/${file.filename}`,
                fileName: file.originalname,
                fileSize: file.size,
                fileType: file.mimetype
              }
            : {})
        },
        include: {
          sender: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } }
        }
      });

      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() }
      });

      const redis = RedisClient.getInstance();
      const recipients =
        conversation.participants.length > 0
          ? conversation.participants.filter((participant) => participant.userId !== userId).map((participant) => participant.userId)
          : [conversation.senderId, conversation.receiverId].filter((id): id is string => Boolean(id && id !== userId));

      for (const receiverId of recipients) {
        await redis.publish(
          new AppEvent(
            'NEW_MESSAGE',
            {
              receiverId,
              message: { ...message, reactions: [] }
            },
            { senderId: userId }
          )
        );
      }

      res.status(201).json({ data: message });
    } catch (error) {
      console.error('Error sending message:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.post('/:conversationId/messages/:messageId/reactions', async (req, res) => {
    try {
      const userId = res.locals.requester?.sub as string | undefined;
      const { conversationId, messageId } = req.params;
      const { emoji } = req.body as { emoji?: string };

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (!emoji) {
        res.status(400).json({ error: 'Emoji is required' });
        return;
      }

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          OR: [
            { senderId: userId },
            { receiverId: userId },
            { participants: { some: { userId } } }
          ]
        },
        include: { participants: true }
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found or access denied' });
        return;
      }

      const message = await prisma.message.findFirst({
        where: { id: messageId, conversationId }
      });

      if (!message) {
        res.status(404).json({ error: 'Message not found' });
        return;
      }

      const existingReaction = await prisma.messageReaction.findFirst({
        where: { messageId, userId }
      });

      const redis = RedisClient.getInstance();
      let action = 'add';
      let result: unknown;

      if (existingReaction) {
        if (existingReaction.emoji === emoji) {
          await prisma.messageReaction.delete({ where: { id: existingReaction.id } });
          action = 'remove';
          result = { message: 'Reaction removed' };
        } else {
          result = {
            data: await prisma.messageReaction.update({
              where: { id: existingReaction.id },
              data: { emoji }
            })
          };
          action = 'update';
        }
      } else {
        result = {
          data: await prisma.messageReaction.create({
            data: {
              id: crypto.randomUUID(),
              messageId,
              userId,
              emoji
            }
          })
        };
      }

      const recipients =
        conversation.participants.length > 0
          ? conversation.participants.filter((participant) => participant.userId !== userId).map((participant) => participant.userId)
          : [conversation.senderId, conversation.receiverId].filter((id): id is string => Boolean(id && id !== userId));

      for (const receiverId of recipients) {
        await redis.publish(
          new AppEvent(
            'MESSAGE_REACTION',
            {
              conversationId,
              messageId,
              userId,
              emoji: action === 'remove' ? existingReaction?.emoji : emoji,
              action,
              receiverId
            },
            { senderId: userId }
          )
        );
      }

      res.status(200).json(result);
    } catch (error) {
      console.error('Error reacting to message:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.delete('/:conversationId', async (req, res) => {
    try {
      const userId = res.locals.requester?.sub as string | undefined;
      const { conversationId } = req.params;

      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          OR: [
            { senderId: userId },
            { receiverId: userId },
            { participants: { some: { userId } } }
          ]
        }
      });

      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      await prisma.$transaction([
        prisma.messageReaction.deleteMany({
          where: {
            message: {
              conversationId
            }
          }
        }),
        prisma.message.deleteMany({ where: { conversationId } }),
        prisma.conversationParticipant.deleteMany({ where: { conversationId } }),
        prisma.conversation.delete({ where: { id: conversationId } })
      ]);

      res.status(200).json({ message: 'Conversation deleted successfully' });
    } catch (error) {
      console.error('Error deleting conversation:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export function setupConversationModule(ctx: ServiceContext): Router {
  const router = Router();
  router.use('/conversations', ctx.mdlFactory.auth, buildConversationRouter());
  return router;
}
