from django.urls import path
from . import auth_views, views, member_views, chat_views

urlpatterns = [
    path('auth/csrf/', auth_views.csrf),
    path('auth/register/', auth_views.register),
    path('auth/login/', auth_views.sign_in),
    path('auth/logout/', auth_views.sign_out),
    path('auth/me/', auth_views.me),
    path('organizations/', views.OrganizationListView.as_view()),
    path('organizations/<uuid:pk>/activate/', views.ActivateOrganizationView.as_view()),
    path('organizations/<uuid:pk>/members/', views.OrganizationMembersView.as_view()),
    path('organizations/<uuid:pk>/members/<uuid:member_id>/', member_views.OrganizationMemberDetailView.as_view()),
    path('organizations/<uuid:pk>/invitations/', views.OrganizationInvitationsView.as_view()),
    path('invitations/<str:token>/', auth_views.invitation_preview),
    path('invitations/<str:token>/accept/', auth_views.invitation_accept),
    path('chats/', chat_views.ChatsView.as_view()),
    path('chats/<uuid:chat_id>/messages/', chat_views.ChatMessagesView.as_view()),
    path('chats/<uuid:chat_id>/messages/<uuid:message_id>/', chat_views.ChatMessageDetailView.as_view()),
    path('chats/<uuid:chat_id>/participants/', chat_views.ChatParticipantsView.as_view()),
    path('chats/<uuid:chat_id>/participants/<uuid:user_id>/', chat_views.ChatParticipantDetailView.as_view()),
    path('teams/', views.TeamsView.as_view()),
    path('teams/<uuid:team_id>/channels/', views.TeamChannelsView.as_view()),
    path('teams/<uuid:team_id>/members/', views.TeamMembersView.as_view()),
    path('channels/<uuid:channel_id>/messages/', views.ChannelMessagesView.as_view()),
]
