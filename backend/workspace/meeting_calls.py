"""Native WebRTC configuration and short-lived authenticated presence."""
import base64
import hashlib
import hmac
import time
from datetime import timedelta

from django.conf import settings
from django.contrib.sessions.models import Session
from django.db import transaction
from django.db.models import Q, F
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Meeting, MeetingCallPeer, OrganizationMember
from .device_sessions import GENERATION_KEY, live_websocket_session
from .meetings import get_meeting

PEER_TTL = 90
MAX_PEERS = 6


def socket_allowed(scope, meeting_id):
    user, session = scope.get('user'), scope.get('session')
    if not user or not user.is_authenticated or not session:
        return False
    org_id = session.get('active_organization_id')
    if not org_id or not live_websocket_session(user.pk, session.session_key, session.get(GENERATION_KEY)):
        return False
    stored = Session.objects.filter(session_key=session.session_key).first()
    if not stored or str(stored.get_decoded().get('active_organization_id')) != str(org_id):
        return False
    member = OrganizationMember.objects.filter(organization_id=org_id, user=user, user__is_active=True).first()
    if not member:
        return False
    return Meeting.objects.filter(pk=meeting_id, organization_id=org_id, cancelled=False, call_ended_at__isnull=True,
        ends_at__gt=timezone.now(), attendees__user=user, attendees__invited_at__gte=member.joined_at).filter(
            Q(channel__isnull=True) | Q(channel__team__members__user=user, channel__team__members__joined_at__lte=F('attendees__invited_at'))
        ).exists()


def peer_data(peer):
    return {'id':str(peer.pk), 'user_id':str(peer.user_id), 'name':peer.user.full_name, 'audio':peer.audio, 'video':peer.video, 'hand_raised':peer.hand_raised, 'screen_sharing':peer.screen_sharing}


def register_peer(scope, meeting_id, channel_name):
    with transaction.atomic():
        Meeting.objects.select_for_update().get(pk=meeting_id)
        if not socket_allowed(scope, meeting_id):
            return {'error':4403}
        cutoff = timezone.now()-timedelta(seconds=PEER_TTL)
        stale = list(MeetingCallPeer.objects.filter(meeting_id=meeting_id, updated_at__lt=cutoff).values_list('id',flat=True))
        MeetingCallPeer.objects.filter(meeting_id=meeting_id, updated_at__lt=cutoff).delete()
        if MeetingCallPeer.objects.filter(meeting_id=meeting_id, user=scope['user']).exists():
            return {'error':4409}
        if MeetingCallPeer.objects.filter(meeting_id=meeting_id).count() >= MAX_PEERS:
            return {'error':4429}
        peer = MeetingCallPeer.objects.create(meeting_id=meeting_id, user=scope['user'], channel_name=channel_name, session_key=scope['session'].session_key)
        peers = MeetingCallPeer.objects.filter(meeting_id=meeting_id).exclude(pk=peer.pk).select_related('user')
        return {'self':peer_data(peer), 'peers':[peer_data(p) for p in peers], 'stale':[str(v) for v in stale]}


def ice_configuration(user_id):
    servers = []
    urls = getattr(settings,'CALL_STUN_URLS',[])
    if urls:
        if any(not u.startswith(('stun:','stuns:')) for u in urls):
            raise ValidationError('The administrator must correct CALL_STUN_URLS.')
        servers.append({'urls':urls})
    turn_urls = getattr(settings,'CALL_TURN_URLS',[])
    secret = getattr(settings,'CALL_TURN_SHARED_SECRET','')
    if turn_urls:
        if not secret or any(not u.startswith(('turn:','turns:')) for u in turn_urls):
            raise ValidationError('The administrator must configure TURN URLs and its shared secret.')
        username = f'{int(time.time())+3600}:{user_id}'
        credential = base64.b64encode(hmac.new(secret.encode(),username.encode(),hashlib.sha1).digest()).decode()
        servers.append({'urls':turn_urls,'username':username,'credential':credential})
    policy = getattr(settings,'CALL_ICE_TRANSPORT_POLICY','all')
    if policy not in ('all','relay') or (policy=='relay' and not turn_urls):
        raise ValidationError('The administrator must configure a TURN server before using relay-only calls.')
    return {'iceServers':servers,'iceTransportPolicy':policy}


class MeetingCallConfigView(APIView):
    def get(self,request,meeting_id):
        row = get_meeting(request,meeting_id)
        if row.cancelled or row.call_ended_at or row.ends_at <= timezone.now():
            raise ValidationError('This meeting is cancelled, ended or expired.')
        response = Response({'rtc':ice_configuration(request.user.pk),'websocket_path':f'/ws/meetings/{row.pk}/call/',
                             'max_peers':MAX_PEERS,'relay_configured':bool(getattr(settings,'CALL_TURN_URLS',[]))})
        response['Cache-Control']='no-store'
        return response


class MeetingCallEndView(APIView):
    def post(self,request,meeting_id):
        with transaction.atomic():
            row = get_meeting(request,meeting_id,lock=True,organizer=True)
            row.call_ended_at = timezone.now()
            row.revision += 1
            row.save(update_fields=['call_ended_at','revision','updated_at'])
        return Response({'status':'ended'})
