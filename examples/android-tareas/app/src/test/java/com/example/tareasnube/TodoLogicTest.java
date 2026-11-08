package com.example.tareasnube;

import org.junit.Test;
import static org.junit.Assert.*;

public class TodoLogicTest {
    @Test public void addingTrimsTaskAndPreservesIt() {
        TodoLogic logic = new TodoLogic();
        TodoLogic.Task task = logic.add("  Comprar pan  ");
        assertNotNull(task);
        assertEquals("Comprar pan", task.title);
        assertEquals(1, logic.getTasks().size());
    }

    @Test public void togglingAndRemovingWorks() {
        TodoLogic logic = new TodoLogic();
        TodoLogic.Task task = logic.add("Estudiar");
        assertFalse(task.completed);
        assertTrue(logic.toggle(task.id));
        assertTrue(logic.getTasks().get(0).completed);
        assertTrue(logic.toggle(task.id));
        assertFalse(logic.getTasks().get(0).completed);
        assertTrue(logic.remove(task.id));
        assertEquals(0, logic.getTasks().size());
        assertFalse(logic.remove(task.id));
    }

    @Test public void blankTitlesAreRejected() {
        TodoLogic logic = new TodoLogic();
        assertNull(logic.add(""));
        assertNull(logic.add("   "));
        assertNull(logic.add(null));
        assertTrue(logic.getTasks().isEmpty());
    }

    @Test public void restoredTaskKeepsCompletionState() {
        TodoLogic logic = new TodoLogic();
        logic.restore(new TodoLogic.Task("old-id", "Persistida", true));
        assertEquals("Persistida", logic.getTasks().get(0).title);
        assertTrue(logic.getTasks().get(0).completed);
    }
}
