from django.urls import path
from . import views

urlpatterns = [
    path("config/", views.ConfigurationView.as_view()),
    path("accounts/", views.AccountsView.as_view()),
    path("accounts/<uuid:account_id>/", views.AccountDetailView.as_view()),
    path("oauth/<str:provider>/start/", views.OAuthStartView.as_view()),
    path("oauth/<str:provider>/callback/", views.OAuthCallbackView.as_view()),
    path("accounts/<uuid:account_id>/folders/", views.FoldersView.as_view()),
    path("accounts/<uuid:account_id>/messages/", views.MessagesView.as_view()),
    path("accounts/<uuid:account_id>/messages/<str:message_id>/", views.MessageDetailView.as_view()),
    path("accounts/<uuid:account_id>/messages/<str:message_id>/actions/", views.MessageActionView.as_view()),
    path("accounts/<uuid:account_id>/messages/<str:message_id>/attachments/<str:attachment_id>/", views.AttachmentView.as_view()),
    path("accounts/<uuid:account_id>/drafts/", views.DraftsView.as_view()),
    path("accounts/<uuid:account_id>/drafts/<str:message_id>/", views.DraftDetailView.as_view()),
    path("accounts/<uuid:account_id>/send/", views.SendView.as_view()),
]
