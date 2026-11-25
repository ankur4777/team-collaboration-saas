from rest_framework import serializers
from .models import User, Organization, OrganizationMember, Team, Channel, Message, ChatConversation, ChatParticipant, ChatMessage

class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ('id', 'email', 'full_name')

class OrganizationSerializer(serializers.ModelSerializer):
    class Meta:
        model = Organization
        fields = ('id', 'name', 'slug', 'created_at')

class OrganizationMemberSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)
    class Meta:
        model = OrganizationMember
        fields = ('id', 'role', 'joined_at', 'user')

class TeamSerializer(serializers.ModelSerializer):
    class Meta:
        model = Team
        fields = ('id', 'name', 'description', 'created_at', 'archived_at')

class ChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Channel
        fields = ('id', 'name', 'description', 'created_at', 'archived_at')

class MessageSerializer(serializers.ModelSerializer):
    reply_to_id = serializers.UUIDField(read_only=True, allow_null=True)
    sender = UserSerializer(read_only=True)
    class Meta:
        model = Message
        fields = ('id', 'body', 'created_at', 'edited_at', 'deleted_at', 'sender', 'reply_to_id', 'is_forwarded', 'pinned_at')


class ChatParticipantSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = ChatParticipant
        fields = ('user', 'joined_at', 'last_read_at')


class ChatConversationSerializer(serializers.ModelSerializer):
    participants = ChatParticipantSerializer(many=True, read_only=True)
    created_by = UserSerializer(read_only=True)
    unread_count = serializers.SerializerMethodField()
    archived_at = serializers.SerializerMethodField()

    def get_archived_at(self, obj):
        request = self.context.get('request')
        if request and request.user.is_authenticated:
            participant = next((p for p in obj.participants.all() if p.user_id == request.user.pk), None)
            if participant and participant.archived_at:
                return participant.archived_at.isoformat()
        return None

    class Meta:
        model = ChatConversation
        fields = ('id', 'kind', 'title', 'created_at', 'updated_at', 'created_by', 'participants', 'unread_count', 'archived_at')

    def get_unread_count(self, obj):
        request = self.context.get('request')
        if request is None or not request.user.is_authenticated:
            return 0
        current = next((member for member in obj.participants.all()
                        if member.user_id == request.user.pk), None)
        if current is None:
            return 0
        baseline = max(filter(None, (current.joined_at, current.last_read_at)))
        return obj.messages.filter(
            created_at__gt=baseline, deleted_at__isnull=True,
        ).exclude(sender_id=request.user.pk).count()


class ChatMessageSerializer(serializers.ModelSerializer):
    reply_to_id = serializers.UUIDField(read_only=True, allow_null=True)
    sender = UserSerializer(read_only=True)
    reactions = serializers.SerializerMethodField()

    def get_reactions(self, obj):
        if obj.deleted_at is not None:
            return []
        groups = {}
        for reaction in obj.reactions.all():
            row = groups.setdefault(
                reaction.emoji, {'emoji': reaction.emoji, 'count': 0, 'user_ids': []}
            )
            row['count'] += 1
            row['user_ids'].append(str(reaction.user_id))
        return sorted(groups.values(), key=lambda row: row['emoji'])

    class Meta:
        model = ChatMessage
        fields = ('id', 'body', 'created_at', 'edited_at', 'deleted_at', 'sender', 'reactions', 'reply_to_id', 'is_forwarded', 'pinned_at')
