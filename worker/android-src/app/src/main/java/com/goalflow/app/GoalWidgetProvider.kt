package com.goalflow.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

class GoalWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        appWidgetIds.forEach { updateOne(context, manager, it) }
    }

    companion object {
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, GoalWidgetProvider::class.java))
            ids.forEach { updateOne(context, manager, it) }
        }

        private fun updateOne(context: Context, manager: AppWidgetManager, id: Int) {
            val plan = GoalData.load(context)
            val views = RemoteViews(context.packageName, R.layout.goal_widget)
            views.setTextViewText(R.id.widget_goal_title, plan.title)
            views.setProgressBar(R.id.widget_progress, 100, plan.progress, false)
            views.setTextViewText(
                R.id.widget_progress_text,
                "${plan.progress}% hoàn thành · ${plan.progressTasks.count { it.done }}/${plan.progressTasks.size} việc nhỏ"
            )
            val next = plan.nextTask
            views.setTextViewText(
                R.id.widget_next_task,
                if (next == null) {
                    if (plan.tasks.isEmpty()) "Mở app để thêm việc đầu tiên" else "Đã hoàn thành mọi việc!"
                } else {
                    "Tiếp theo: ${next.title}" + if (next.dueDate.isNotBlank()) " · ${next.dueDate}" else ""
                }
            )
            val intent = Intent(context, MainActivity::class.java)
            val pending = PendingIntent.getActivity(
                context, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_root, pending)
            manager.updateAppWidget(id, views)
        }
    }
}
