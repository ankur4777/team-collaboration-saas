"""Ephemeral captions/reactions and administrator-configured text translation."""
from datetime import timedelta
from urllib.parse import urlsplit
import httpx
from django.conf import settings
from django.core.cache import cache
from django.utils import timezone
from rest_framework.exceptions import ValidationError, PermissionDenied, Throttled
from rest_framework.response import Response
from rest_framework.views import APIView
from .models import MeetingCallPeer
from .meetings import get_meeting

REACTIONS = ('👍','👏','❤️','😂','🎉','🙌','😮','👎')
CAPTION_LANGUAGES = ('en-US','en-GB','hi-IN','pa-IN','fr-FR','es-ES','de-DE','pt-BR','ar-SA','bn-IN','ja-JP')
TRANSLATION_LANGUAGES = ('en','hi','pa','fr','es','de','pt','ar','bn','ja')

class CallTranslateView(APIView):
    def post(self,request,meeting_id):
        row=get_meeting(request,meeting_id)
        if row.cancelled or row.call_ended_at or row.ends_at<=timezone.now():
            raise PermissionDenied('This call has ended.')
        if not MeetingCallPeer.objects.filter(meeting=row,user=request.user,session_key=request.session.session_key,
            updated_at__gte=timezone.now()-timedelta(seconds=90)).exists():
            raise PermissionDenied('Join the call before translating captions.')
        if not isinstance(request.data,dict):
            raise ValidationError('Expected caption text and language fields.')
        text,source,target=request.data.get('text'),request.data.get('source'),request.data.get('target')
        if not isinstance(text,str) or not text.strip() or len(text)>500 or source not in TRANSLATION_LANGUAGES or target not in TRANSLATION_LANGUAGES:
            raise ValidationError('Choose valid languages and 1–500 characters of caption text.')
        endpoint=getattr(settings,'CALL_TRANSLATE_URL','')
        try: parsed=urlsplit(endpoint)
        except ValueError: parsed=urlsplit('')
        if parsed.scheme not in ('http','https') or not parsed.netloc or parsed.username or parsed.password or parsed.fragment:
            return Response({'detail':'Speech translation needs an administrator-configured translation service.'},status=503)
        # Text/credentials never enter cache; only a bounded per-user counter does.
        key=f'call-translate:{request.user.pk}:{int(timezone.now().timestamp())//60}'
        cache.add(key,0,timeout=65)
        try: count=cache.incr(key)
        except ValueError:
            cache.set(key,1,timeout=65);count=1
        if count>60:
            raise Throttled(wait=60,detail='Translation limit reached. Please wait a minute.')
        if source==target:
            return Response({'text':text.strip()})
        payload={'q':text.strip(),'source':source,'target':target,'format':'text'}
        secret=getattr(settings,'CALL_TRANSLATE_API_KEY','')
        if secret: payload['api_key']=secret
        try:
            with httpx.Client(timeout=4,follow_redirects=False,trust_env=False) as client:
                response=client.post(endpoint,json=payload)
                response.raise_for_status()
                if len(response.content)>20000: raise ValueError('oversized translation')
                translated=response.json().get('translatedText')
                if not isinstance(translated,str) or not translated.strip() or len(translated)>3000:
                    raise ValueError('invalid translation')
        except (httpx.HTTPError,httpx.InvalidURL,ValueError,TypeError,AttributeError):
            return Response({'detail':'Translation is unavailable for this language or the service is not reachable. Original captions are still shown.'},status=502)
        result=Response({'text':translated.strip()})
        result['Cache-Control']='no-store'
        return result
