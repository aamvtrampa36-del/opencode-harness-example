package com.example.tareasnube;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Plain Java task operations, independently testable without Android. */
public final class TodoLogic {
    public static final class Task {
        public final String id;
        public final String title;
        public boolean completed;

        public Task(String id, String title, boolean completed) {
            if (id == null || id.isEmpty()) throw new IllegalArgumentException("Missing id");
            if (title == null || title.trim().isEmpty()) throw new IllegalArgumentException("Missing title");
            this.id = id;
            this.title = title.trim();
            this.completed = completed;
        }
    }

    private final ArrayList<Task> tasks = new ArrayList<>();

    /** Returns null for blank text; otherwise adds the new task. */
    public Task add(String title) {
        if (title == null || title.trim().isEmpty()) return null;
        String cleaned = title.trim();
        if (cleaned.length() > 200) cleaned = cleaned.substring(0, 200);
        Task task = new Task(UUID.randomUUID().toString(), cleaned, false);
        tasks.add(task);
        return task;
    }

    public void restore(Task task) {
        if (task != null) tasks.add(task);
    }

    public boolean toggle(String id) {
        for (Task task : tasks) {
            if (task.id.equals(id)) {
                task.completed = !task.completed;
                return true;
            }
        }
        return false;
    }

    public boolean remove(String id) {
        for (int i = 0; i < tasks.size(); i++) {
            if (tasks.get(i).id.equals(id)) {
                tasks.remove(i);
                return true;
            }
        }
        return false;
    }

    public List<Task> getTasks() {
        return new ArrayList<>(tasks);
    }
}
