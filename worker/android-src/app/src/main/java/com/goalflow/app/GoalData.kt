package com.goalflow.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class GoalTask(
    val id: String = UUID.randomUUID().toString(),
    val title: String,
    val dueDate: String = "",
    val done: Boolean = false,
    val parentTaskId: String = ""
)

data class GoalPlan(
    val title: String = "Học tập lớp 12",
    val deadline: String = "",
    val tasks: List<GoalTask> = emptyList()
) {
    val progressTasks: List<GoalTask>
        get() = tasks.filter { task -> tasks.none { it.parentTaskId == task.id } }
    val progress: Int
        get() = if (progressTasks.isEmpty()) 0 else (progressTasks.count { it.done } * 100 / progressTasks.size)
    val nextTask: GoalTask?
        get() = progressTasks.firstOrNull { !it.done }
}

object GoalData {
    private const val PREFS = "goalflow_data"
    private const val KEY_PLAN = "plan"

    fun load(context: Context): GoalPlan {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_PLAN, null) ?: return samplePlan()
        return try {
            val obj = JSONObject(raw)
            val array = obj.optJSONArray("tasks") ?: JSONArray()
            val tasks = (0 until array.length()).mapNotNull { i ->
                val item = array.optJSONObject(i) ?: return@mapNotNull null
                GoalTask(
                    id = item.optString("id", UUID.randomUUID().toString()),
                    title = item.optString("title", ""),
                    dueDate = item.optString("dueDate", ""),
                    done = item.optBoolean("done", false),
                    parentTaskId = item.optString("parentTaskId", "")
                )
            }
            GoalPlan(obj.optString("title", "Mục tiêu của bạn"), obj.optString("deadline", ""), tasks)
        } catch (_: Exception) { samplePlan() }
    }

    fun save(context: Context, plan: GoalPlan) {
        val tasks = JSONArray()
        plan.tasks.forEach { task ->
            tasks.put(JSONObject().apply {
                put("id", task.id)
                put("title", task.title)
                put("dueDate", task.dueDate)
                put("done", task.done)
                put("parentTaskId", task.parentTaskId)
            })
        }
        val obj = JSONObject().apply {
            put("title", plan.title)
            put("deadline", plan.deadline)
            put("tasks", tasks)
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_PLAN, obj.toString()).apply()
        GoalWidgetProvider.refresh(context)
    }

    fun samplePlan() = GoalPlan(
        title = "Học tập lớp 12",
        deadline = "",
        tasks = listOf(
            GoalTask(title = "Ôn bài hôm nay"),
            GoalTask(title = "Làm bài tập còn thiếu"),
            GoalTask(title = "Đọc sách 10 phút")
        )
    )

    fun daysUntil(date: String): String {
        if (date.isBlank()) return ""
        return try {
            val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
            fmt.isLenient = false
            val target = fmt.parse(date) ?: return ""
            val today = fmt.parse(fmt.format(Date())) ?: return ""
            val days = ((target.time - today.time) / 86_400_000L).toInt()
            when {
                days < 0 -> "Quá hạn ${-days} ngày"
                days == 0 -> "Hạn hôm nay"
                else -> "Còn $days ngày"
            }
        } catch (_: Exception) { "" }
    }
}
