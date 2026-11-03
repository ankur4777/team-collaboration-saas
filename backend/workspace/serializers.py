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
        fields = ('id', 'name', 'description', 'created_at')

class ChannelSerializer(serializers.ModelSerializer):
    class Meta:
        model = Channel
        fields = ('id', 'name', 'description', 'created_at')

class MessageSerializer(serializers.ModelSerializer):
    sender = UserSerializer(read_only=True)
    class Meta:
        model = Message
        fields = ('id', 'body', 'created_at', 'sender')


class ChatParticipantSerializer(serializers.ModelSerializer):
    user = UserSerializer(read_only=True)

    class Meta:
        model = ChatParticipant
        fields = ('user', 'joined_at', 'last_read_at')


class ChatConversationSerializer(serializers.ModelSerializer):
    participants = ChatParticipantSerializer(many=True, read_only=True)
    created_by = UserSerializer(read_only=True)
    unread_count = serializers.SerializerMethodField()

    class Meta:
        model = ChatConversation
        fields = ('id', 'kind', 'title', 'created_at', 'updated_at', 'created_by', 'participants', 'unread_count')

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
    sender = UserSerializer(read_only=True)

    class Meta:
        model = ChatMessage
        fields = ('id', 'body', 'created_at', 'edited_at', 'deleted_at', 'sender')
